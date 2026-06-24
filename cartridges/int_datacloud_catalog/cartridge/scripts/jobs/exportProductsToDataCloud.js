'use strict';

var ProductMgr  = require('dw/catalog/ProductMgr');
var CategoryMgr = require('dw/catalog/CatalogMgr');
var Logger      = require('dw/system/Logger');
var Site        = require('dw/system/Site');
var Status      = require('dw/system/Status');

var authService      = require('int_datacloud_catalog/cartridge/scripts/datacloud/authService');
var ingestionService = require('int_datacloud_catalog/cartridge/scripts/datacloud/ingestionService');

var log = Logger.getLogger('int_datacloud_catalog', 'exportProductsToDataCloud');

var CSV_HEADER = 'product_id,product_name,short_description,long_description,online_flag,product_type,online_from,online_to,last_modified,creation_date,brand,manufacturer_name,in_stock';

var DEFAULT_CONFIG = {
    catalogId:          '',
    categoryId:         'root',
    categoryRollup:     true,
    onlineOnly:         true,
    inStockOnly:        false,
    batchSizeKB:        800,
    objectName:         'Product',
    serviceId:          'int_datacloud.auth',
    maxPollAttempts:    120,
    enableDebugLogging: false
};

function parseConfig(raw) {
    if (!raw || raw.trim() === '') return DEFAULT_CONFIG;
    try {
        var parsed = JSON.parse(raw);
        var cfg = {};
        var keys = Object.keys(DEFAULT_CONFIG);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            cfg[k] = parsed.hasOwnProperty(k) ? parsed[k] : DEFAULT_CONFIG[k];
        }
        return cfg;
    } catch (e) {
        log.error('Invalid JobConfig JSON — using defaults. Error: {0}', e.message);
        return DEFAULT_CONFIG;
    }
}

function csvEscape(value) {
    if (value === null || value === undefined) return '""';
    var str = String(value).replace(/"/g, '""');
    return '"' + str + '"';
}

function formatDate(d) {
    if (!d) return '';
    try { return new Date(d.getTime()).toISOString(); } catch (e) { return ''; }
}

function getProductType(product) {
    if (product.isMaster())     return 'Variation Base Product';
    if (product.isVariant())    return 'Variation Product';
    if (product.isBundle())     return 'Bundle';
    if (product.isProductSet()) return 'Set';
    return 'Product';
}

// Collects all products from a category, optionally recursing into sub-categories.
function collectCategoryProducts(category, rollup, cfg) {
    var collected = [];
    var queue = [category];
    while (queue.length > 0) {
        var cat = queue.shift();
        var products = cat.getProducts();
        for (var i = 0; i < products.length; i++) {
            collected.push(products[i]);
        }
        if (rollup) {
            var subs = cat.getSubCategories();
            for (var j = 0; j < subs.length; j++) {
                queue.push(subs[j]);
            }
        }
    }
    if (cfg.enableDebugLogging) {
        log.info('DEBUG: collectCategoryProducts — category={0} rollup={1} collected={2}', category.getID(), rollup, collected.length);
    }
    return collected;
}

function uploadProductsInBatches(uploadFn, cfg) {
    var batchSizeLimit = cfg.batchSizeKB * 1000;
    var batchRows      = [CSV_HEADER];
    var batchSize      = CSV_HEADER.length;
    var total          = 0;
    var skipped        = 0;
    var batchNum       = 0;

    // Determine product source: category-scoped or full site query
    var useIterator  = true;
    var allProducts  = null;
    var productArray = null;

    if (cfg.catalogId && cfg.categoryId && cfg.categoryId !== 'root') {
        var catalog = CategoryMgr.getCatalog(cfg.catalogId);
        if (!catalog) {
            log.error('Catalog not found: {0}', cfg.catalogId);
            return 0;
        }
        var category = catalog.getCategory(cfg.categoryId);
        if (!category) {
            log.error('Category not found: {0} in catalog {1}', cfg.categoryId, cfg.catalogId);
            return 0;
        }
        if (cfg.enableDebugLogging) {
            log.info('DEBUG: Using category scope — catalog={0} category={1} rollup={2}', cfg.catalogId, cfg.categoryId, cfg.categoryRollup);
        }
        productArray = collectCategoryProducts(category, cfg.categoryRollup, cfg);
        useIterator  = false;
    } else {
        if (cfg.enableDebugLogging) {
            log.info('DEBUG: Using queryAllSiteProducts — onlineOnly={0} inStockOnly={1}', cfg.onlineOnly, cfg.inStockOnly);
        }
        allProducts = ProductMgr.queryAllSiteProducts();
    }

    function processProduct(product) {
        if (cfg.onlineOnly && !product.isOnline()) { skipped++; return; }
        if (!product.getName()) { skipped++; return; }

        var inStock = false;
        try {
            var availModel = product.getAvailabilityModel();
            inStock = availModel ? availModel.isInStock() : false;
        } catch (e) {
            inStock = false;
        }

        if (cfg.inStockOnly && !inStock) { skipped++; return; }

        var productId   = product.getID();
        var productType = getProductType(product);
        var shortDesc   = product.getShortDescription() ? product.getShortDescription().toString() : '';
        var longDesc    = product.getLongDescription()  ? product.getLongDescription().toString()  : '';

        if (cfg.enableDebugLogging) {
            log.info('DEBUG: product={0} type={1} online={2} inStock={3}', productId, productType, product.isOnline(), inStock);
        }

        var row = [
            csvEscape(productId),
            csvEscape(product.getName()),
            csvEscape(shortDesc),
            csvEscape(longDesc),
            csvEscape(product.isOnline()),
            csvEscape(productType),
            csvEscape(formatDate(product.getOnlineFrom())),
            csvEscape(formatDate(product.getOnlineTo())),
            csvEscape(formatDate(product.getLastModified())),
            csvEscape(formatDate(product.getCreationDate())),
            csvEscape(product.getBrand()),
            csvEscape(product.getManufacturerName()),
            csvEscape(inStock)
        ].join(',');

        batchRows.push(row);
        batchSize += row.length + 1;
        total++;

        if (batchSize >= batchSizeLimit) {
            batchNum++;
            uploadFn(batchRows.join('\n'), batchNum);
            batchRows = [CSV_HEADER];
            batchSize = CSV_HEADER.length;
        }
    }

    if (useIterator) {
        try {
            while (allProducts.hasNext()) {
                processProduct(allProducts.next());
            }
        } finally {
            allProducts.close();
        }
    } else {
        for (var i = 0; i < productArray.length; i++) {
            processProduct(productArray[i]);
        }
    }

    if (batchRows.length > 1) {
        batchNum++;
        uploadFn(batchRows.join('\n'), batchNum);
    }

    log.info('Exported: {0}, Skipped: {1} (onlineOnly={2} inStockOnly={3})', total, skipped, cfg.onlineOnly, cfg.inStockOnly);
    return total;
}

function execute(parameters) {
    var connectorName = parameters.ConnectorName;
    if (!connectorName) {
        log.error('Missing required job parameter ConnectorName');
        return new Status(Status.ERROR, 'MISSING_PARAMS', 'ConnectorName parameter is blank');
    }

    var cfg = parseConfig(parameters.JobConfig);
    var siteID = Site.getCurrent().getID();

    log.info('Starting product export — site={0} connector={1} object={2} serviceId={3}', siteID, connectorName, cfg.objectName, cfg.serviceId);
    log.info('Config — onlineOnly={0} inStockOnly={1} catalogId={2} categoryId={3} categoryRollup={4} batchSizeKB={5} maxPollAttempts={6} enableDebugLogging={7}',
        cfg.onlineOnly, cfg.inStockOnly, cfg.catalogId || '(site default)', cfg.categoryId, cfg.categoryRollup, cfg.batchSizeKB, cfg.maxPollAttempts, cfg.enableDebugLogging);

    // Step 1: Authenticate
    var auth;
    try {
        auth = authService.getAccessToken(cfg.serviceId);
        log.info('Authentication successful — DC instance: {0}', auth.dataCloudInstanceURL);
    } catch (e) {
        log.error('Authentication failed: {0}', e.message);
        return new Status(Status.ERROR, 'AUTH_FAILED', e.message);
    }

    var instanceURL = auth.dataCloudInstanceURL;

    // Step 2: Create ingestion job
    var jobId;
    try {
        jobId = ingestionService.createJob(instanceURL, auth.accessToken, connectorName, cfg.objectName);
        log.info('Created ingestion job: {0}', jobId);
    } catch (e) {
        log.error('Failed to create job: {0}', e.message);
        return new Status(Status.ERROR, 'JOB_CREATE_FAILED', e.message);
    }

    // Step 3: Upload batches
    var totalProducts;
    var batchCount = 0;
    try {
        totalProducts = uploadProductsInBatches(function (csvBatch, batchNum) {
            ingestionService.uploadJobData(instanceURL, auth.accessToken, jobId, csvBatch);
            batchCount++;
            log.info('Uploaded batch {0} ({1} chars)', batchNum, csvBatch.length);
        }, cfg);

        log.info('Upload complete — {0} products in {1} batches', totalProducts, batchCount);

        if (totalProducts === 0) {
            log.warn('No products matched filters — aborting ingestion');
            ingestionService.closeJob(instanceURL, auth.accessToken, jobId);
            return new Status(Status.OK);
        }
    } catch (e) {
        log.error('Failed to upload product data: {0}', e.message);
        try {
            ingestionService.abortJob(instanceURL, auth.accessToken, jobId);
            log.info('Aborted orphaned ingestion job: {0}', jobId);
        } catch (abortErr) {
            log.error('Failed to abort job {0}: {1}', jobId, abortErr.message);
        }
        return new Status(Status.ERROR, 'UPLOAD_FAILED', e.message);
    }

    // Step 4: Close job — signals Data Cloud to begin processing asynchronously
    try {
        ingestionService.closeJob(instanceURL, auth.accessToken, jobId);
        log.info('Closed job: {0} Data Cloud will process asynchronously. Check Data Cloud ingestion logs for final status.', jobId);
    } catch (e) {
        log.error('Failed to close job: {0}', e.message);
        return new Status(Status.ERROR, 'CLOSE_JOB_FAILED', e.message);
    }

    return new Status(Status.OK);

    // // Step 5: Poll until JobComplete or Failed
    // var finalState;
    // try {
    //     finalState = ingestionService.waitForJobCompletion(instanceURL, auth.accessToken, jobId, cfg.maxPollAttempts);
    //     log.info('Job {0} finished with state: {1}', jobId, finalState);
    // } catch (e) {
    //     log.error('Failed polling job status: {0}', e.message);
    //     return new Status(Status.ERROR, 'POLL_FAILED', e.message);
    // }

    // if (finalState === 'JobComplete') {
    //     return new Status(Status.OK);
    // }

    // return new Status(Status.ERROR, 'JOB_FAILED', 'Job ended with state: ' + finalState);
}

module.exports = { execute: execute };
