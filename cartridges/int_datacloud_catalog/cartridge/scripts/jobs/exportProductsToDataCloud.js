'use strict';

var ProductMgr         = require('dw/catalog/ProductMgr');
var Logger             = require('dw/system/Logger');
var Site               = require('dw/system/Site');
var Status             = require('dw/system/Status');
var HashSet            = require('dw/util/HashSet');

var authService      = require('int_datacloud_catalog/cartridge/scripts/datacloud/authService');
var ingestionService = require('int_datacloud_catalog/cartridge/scripts/datacloud/ingestionService');

var log = Logger.getLogger('int_datacloud_catalog', 'exportProductsToDataCloud');

var CSV_HEADER = 'product_id,product_name,short_description,long_description,online_flag,product_type,online_from,online_to,last_modified,creation_date,brand,manufacturer_name';

/**
 * Escapes a value for CSV: wraps in double quotes and escapes internal quotes.
 * @param {*} value
 * @returns {string}
 */
function csvEscape(value) {
    if (value === null || value === undefined) return '""';
    var str = String(value).replace(/"/g, '""');
    return '"' + str + '"';
}

/**
 * Formats a B2C Date as ISO 8601 string, or empty string if null.
 * @param {Date} d
 * @returns {string}
 */
function formatDate(d) {
    if (!d) return '';
    try { return new Date(d.getTime()).toISOString(); } catch (e) { return ''; }
}

// Flush batch when accumulated characters approach 800KB — leaves 200KB headroom
// for products with long descriptions that can't be predicted row-by-row.
var BATCH_SIZE_LIMIT = 800000;

/**
 * Iterates all online products and calls uploadFn for each batch.
 * Batches by character count rather than row count to reliably stay under
 * B2C Commerce's 1MB JS string quota regardless of description length.
 * @param {Function} uploadFn - called with (csvBatch) for each batch
 * @returns {number} total products exported
 */
function uploadProductsInBatches(uploadFn) {
    var allProducts  = ProductMgr.queryAllSiteProducts();
    var batchRows    = [CSV_HEADER];
    var batchSize    = CSV_HEADER.length;
    var total        = 0;
    var skipped      = 0;
    var seenIds      = new HashSet();

    try {
        while (allProducts.hasNext()) {
            var product = allProducts.next();

            if (!product.isOnline()) { skipped++; continue; }
            if (!product.getName()) { skipped++; continue; }

            var productId = product.getID();
            if (!seenIds.add(productId)) { skipped++; continue; }

            var shortDesc = product.getShortDescription() ? product.getShortDescription().toString() : '';
            var longDesc  = product.getLongDescription()  ? product.getLongDescription().toString()  : '';

            var row = [
                csvEscape(productId),
                csvEscape(product.getName()),
                csvEscape(shortDesc),
                csvEscape(longDesc),
                csvEscape(product.isOnline()),
                csvEscape(product.isMaster() ? 'Variation Base Product' : product.isVariant() ? 'Variation Product' : product.isBundle() ? 'Bundle' : product.isProductSet() ? 'Set' : 'Product'),
                csvEscape(formatDate(product.getOnlineFrom())),
                csvEscape(formatDate(product.getOnlineTo())),
                csvEscape(formatDate(product.getLastModified())),
                csvEscape(formatDate(product.getCreationDate())),
                csvEscape(product.getBrand()),
                csvEscape(product.getManufacturerName())
            ].join(',');

            batchRows.push(row);
            batchSize += row.length + 1; // +1 for newline
            total++;

            if (batchSize >= BATCH_SIZE_LIMIT) {
                uploadFn(batchRows.join('\n'));
                batchRows = [CSV_HEADER];
                batchSize = CSV_HEADER.length;
            }
        }

        if (batchRows.length > 1) {
            uploadFn(batchRows.join('\n'));
        }
    } finally {
        allProducts.close();
    }

    log.info('Included: {0}, Skipped (offline or duplicate): {1}', total, skipped);
    return total;
}

/**
 * Job step entry point — called by B2C Commerce job framework.
 * Configure all parameters in Business Manager → Job Schedules.
 *
 * @param {dw.util.HashMap} parameters - Job step parameters from Business Manager
 * @returns {dw.system.Status}
 */
function execute(parameters) {
    var loginURL             = parameters.InstanceURL;
    var consumerKey          = parameters.ConsumerKey;
    var sfUsername           = parameters.SFUsername;
    var connectorName        = parameters.ConnectorName;
    var objectName           = parameters.ObjectName;
    var dataCloudInstanceURL = parameters.DataCloudInstanceURL;
    var privateKeyAlias      = parameters.PrivateKeyAlias;

    if (!loginURL || !consumerKey || !sfUsername || !connectorName || !objectName || !dataCloudInstanceURL || !privateKeyAlias) {
        log.error('Missing required job parameter(s) — check InstanceURL, ConsumerKey, SFUsername, ConnectorName, ObjectName, DataCloudInstanceURL, PrivateKeyAlias');
        return new Status(Status.ERROR, 'MISSING_PARAMS', 'One or more required parameters are blank');
    }

    var siteID = Site.getCurrent().getID();
    log.info('Starting product export for site: {0}', siteID);

    // Step 1: Get access token via JWT Bearer flow
    var auth;
    try {
        auth = authService.getAccessToken(loginURL, consumerKey, sfUsername, privateKeyAlias);
        log.info('Authentication successful');
    } catch (e) {
        log.error('Authentication failed: {0}', e.message);
        return new Status(Status.ERROR, 'AUTH_FAILED', e.message);
    }

    // Step 2: Create bulk ingestion job
    var jobId;
    try {
        jobId = ingestionService.createJob(dataCloudInstanceURL, auth.accessToken, connectorName, objectName);
        log.info('Created ingestion job: {0}', jobId);
    } catch (e) {
        log.error('Failed to create job: {0}', e.message);
        return new Status(Status.ERROR, 'JOB_CREATE_FAILED', e.message);
    }

    // Step 3: Stream products in batches and upload each batch
    var totalProducts;
    var batchCount = 0;
    try {
        totalProducts = uploadProductsInBatches(function (csvBatch) {
            ingestionService.uploadJobData(dataCloudInstanceURL, auth.accessToken, jobId, csvBatch);
            batchCount++;
            log.info('Uploaded batch {0}', batchCount);
        });

        log.info('Uploaded {0} products in {1} batches', totalProducts, batchCount);

        if (totalProducts === 0) {
            log.warn('No products found — aborting ingestion');
            ingestionService.closeJob(dataCloudInstanceURL, auth.accessToken, jobId);
            return new Status(Status.OK);
        }
    } catch (e) {
        log.error('Failed to upload product data: {0}', e.message);
        return new Status(Status.ERROR, 'UPLOAD_FAILED', e.message);
    }

    // Step 5: Close job — signals Data Cloud to begin processing
    try {
        ingestionService.closeJob(dataCloudInstanceURL, auth.accessToken, jobId);
        log.info('Closed job: {0}', jobId);
    } catch (e) {
        log.error('Failed to close job: {0}', e.message);
        return new Status(Status.ERROR, 'CLOSE_JOB_FAILED', e.message);
    }

    // Step 6: Poll until JobComplete or Failed
    var finalState;
    try {
        finalState = ingestionService.waitForJobCompletion(dataCloudInstanceURL, auth.accessToken, jobId);
        log.info('Job {0} finished with state: {1}', jobId, finalState);
    } catch (e) {
        log.error('Failed polling job status: {0}', e.message);
        return new Status(Status.ERROR, 'POLL_FAILED', e.message);
    }

    if (finalState === 'JobComplete') {
        return new Status(Status.OK);
    }

    return new Status(Status.ERROR, 'JOB_FAILED', 'Job ended with state: ' + finalState);
}

module.exports = { execute: execute };
