'use strict';

var ProductMgr         = require('dw/catalog/ProductMgr');
var Logger             = require('dw/system/Logger');
var Site               = require('dw/system/Site');
var Status             = require('dw/system/Status');

var authService      = require('int_datacloud_catalog/cartridge/scripts/datacloud/authService');
var ingestionService = require('int_datacloud_catalog/cartridge/scripts/datacloud/ingestionService');

var log = Logger.getLogger('int_datacloud_catalog', 'exportProductsToDataCloud');

var CSV_HEADER = 'product_id,product_name,short_description,long_description,online_flag,product_type';

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

var BATCH_ROW_LIMIT = 500; // upload every N rows to stay under 1MB B2C string quota

/**
 * Iterates all online products and calls uploadFn for each batch.
 * Never accumulates the full catalog in a single string.
 * @param {Function} uploadFn - called with (csvBatch) for each batch
 * @returns {number} total products exported
 */
function uploadProductsInBatches(uploadFn) {
    var allProducts = ProductMgr.queryAllSiteProducts();
    var batchRows   = [CSV_HEADER];
    var total       = 0;
    var skipped     = 0;

    while (allProducts.hasNext()) {
        var product = allProducts.next();

        if (!product.isOnline()) { skipped++; continue; }

        var shortDesc = product.getShortDescription() ? product.getShortDescription().toString() : '';
        var longDesc  = product.getLongDescription()  ? product.getLongDescription().toString()  : '';

        batchRows.push([
            csvEscape(product.getID()),
            csvEscape(product.getName()),
            csvEscape(shortDesc),
            csvEscape(longDesc),
            csvEscape(product.isOnline()),
            csvEscape(product.isMaster() ? 'Variation Base Product' : product.isVariant() ? 'Variation Product' : product.isBundle() ? 'Bundle' : product.isProductSet() ? 'Set' : 'Product')
        ].join(','));

        total++;

        if (batchRows.length - 1 >= BATCH_ROW_LIMIT) {
            uploadFn(batchRows.join('\n'));
            batchRows = [CSV_HEADER];
        }
    }

    if (batchRows.length > 1) {
        uploadFn(batchRows.join('\n'));
    }

    allProducts.close();
    log.info('Included: {0}, Skipped (offline or non-matching type): {1}', total, skipped);
    return total;
}

/**
 * Job step entry point — called by B2C Commerce job framework.
 *
 * Job parameters (configure in Business Manager → Job Scheduler):
 *   InstanceURL   : https://test.salesforce.com
 *   ConsumerKey   : External Client App consumer key
 *   SFUsername    : jasvirdhillon@salesforce.com
 *   ConnectorName : CrocsCustomB2CConnector
 *   ObjectName    : Product
 *
 * Site scope must be set to CrocsUS so ProductSearchModel queries the correct catalog.
 *
 * Private key file must be uploaded to IMPEX/src/datacloud/datacloud_private_key.der
 *
 * @param {dw.util.HashMap} parameters - Job step parameters from Business Manager
 * @returns {dw.system.Status}
 */
function execute(parameters) {
    var loginURL            = parameters.InstanceURL;
    var consumerKey         = parameters.ConsumerKey;
    var sfUsername          = parameters.SFUsername;
    var connectorName       = parameters.ConnectorName;
    var objectName          = parameters.ObjectName;
    var dataCloudInstanceURL = parameters.DataCloudInstanceURL;

    var siteID = Site.getCurrent().getID();
    log.info('Starting product export for site: {0}', siteID);

    // Step 1: Get access token via JWT Bearer flow
    var auth;
    try {
        auth = authService.getAccessToken(loginURL, consumerKey, sfUsername);
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
