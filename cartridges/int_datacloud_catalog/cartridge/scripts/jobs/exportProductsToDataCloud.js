'use strict';

var ProductMgr   = require('dw/catalog/ProductMgr');
var PriceBookMgr = require('dw/catalog/PriceBookMgr');
var Logger       = require('dw/system/Logger');
var Site         = require('dw/system/Site');
var Status       = require('dw/system/Status');
var authService      = require('int_datacloud_catalog/cartridge/scripts/datacloud/authService');
var ingestionService = require('int_datacloud_catalog/cartridge/scripts/datacloud/ingestionService');

var log = Logger.getLogger('int_datacloud_catalog', 'exportProductsToDataCloud');

var CSV_HEADER = 'product_id,product_name,short_description,long_description,online_flag,product_type,online_from,online_to,last_modified,creation_date,brand,manufacturer_name,in_stock,gender,lifestyle,jibbitable,hide_from_search,category_ids,flat_categories,snipes_label,snipes_color,pricing_price,pricing_regular_price_low,pricing_on_sale,pricing_discount_percentage,refinement_color,refinement_sizes,refinement_jibbitz,size_variation_ids,size_variation_names';

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

/**
 * Returns pipe-delimited online category IDs for a product (includes master's categories for variants).
 */
function getCategoryIDs(product) {
    var cats = product.getOnlineCategories();
    if (!cats || cats.length === 0) {
        if (product.isVariant()) {
            cats = product.masterProduct.getOnlineCategories();
        }
    }
    if (!cats || cats.length === 0) return '';
    var ids = [];
    var it = cats.iterator();
    while (it.hasNext()) {
        ids.push(it.next().getID());
    }
    return ids.join('|');
}

/**
 * Builds a pipe-delimited flat category path string for one category by walking up the tree.
 * e.g. "root > mens > mens-shoes"
 */
function buildCategoryPath(category) {
    var parts = [];
    var current = category;
    while (current && !current.isTopLevel() && !current.isRoot()) {
        parts.unshift(current.getID());
        current = current.getParent();
    }
    return parts.join(' > ');
}

/**
 * Returns pipe-delimited flat category paths for all online categories of a product.
 */
function getFlatCategories(product) {
    var cats = product.getOnlineCategories();
    if (!cats || cats.length === 0) {
        if (product.isVariant()) {
            cats = product.masterProduct.getOnlineCategories();
        }
    }
    if (!cats || cats.length === 0) return '';
    var paths = [];
    var it = cats.iterator();
    while (it.hasNext()) {
        var path = buildCategoryPath(it.next());
        if (path) paths.push(path);
    }
    return paths.join('|');
}

/**
 * Returns pricing fields: price, regularPriceLow, onSale, discountPercentage.
 * Uses site-specific retail and sale price books following the Crocs Pricing.js pattern.
 */
function getPricing(product) {
    try {
        var currentSite    = Site.getCurrent();
        var siteCode       = currentSite.getID().split('_')[1];
        var retailPBPrefix = currentSite.getCustomPreferenceValue('retailPriceBookPrefix') || '';
        var salePBPrefix   = currentSite.getCustomPreferenceValue('salePriceBookPrefix') || '';
        var pbSuffix       = currentSite.getCustomPreferenceValue('PriceBookSuffix') || '';
        var retailPBID     = retailPBPrefix + (siteCode ? siteCode.toUpperCase() : '') + pbSuffix;
        var salePBID       = salePBPrefix   + (siteCode ? siteCode.toUpperCase() : '') + pbSuffix;

        // For masters, find lowest price across orderable variants
        var target = product;
        if (product.isMaster()) {
            var variants = product.getVariants();
            for (var i = 0; i < variants.length; i++) {
                if (variants[i].priceModel.price && variants[i].priceModel.price.value > 0) {
                    target = variants[i];
                    break;
                }
            }
        }

        var priceModel   = target.getPriceModel();
        var retailPB     = PriceBookMgr.getPriceBook(retailPBID);
        var regularPrice = retailPB ? priceModel.getPriceBookPrice(retailPBID) : priceModel.getPrice();
        var salePrice    = priceModel.getPriceBookPrice(salePBID);

        var price              = null;
        var regularPriceLow    = null;
        var onSale             = false;
        var discountPercentage = null;

        if (regularPrice && regularPrice.available && regularPrice.value > 0) {
            regularPriceLow = regularPrice.value;
            if (salePrice && salePrice.available && salePrice.value > 0 && salePrice.value < regularPrice.value) {
                price              = salePrice.value;
                onSale             = true;
                discountPercentage = Math.round((1 - salePrice.value / regularPrice.value) * 100);
            } else {
                price = regularPrice.value;
            }
        }

        return {
            price:              price,
            regularPriceLow:    regularPriceLow,
            onSale:             onSale,
            discountPercentage: discountPercentage
        };
    } catch (e) {
        return { price: null, regularPriceLow: null, onSale: false, discountPercentage: null };
    }
}

/**
 * Returns pipe-delimited size variation IDs and names for a master product.
 */
function getSizeVariations(product) {
    var ids   = [];
    var names = [];
    try {
        var vm        = product.getVariationModel();
        var sizeAttr  = vm.getProductVariationAttribute('size');
        if (!sizeAttr) return { ids: '', names: '' };
        var sizeValues = vm.getAllValues(sizeAttr);
        for (var i = 0; i < sizeValues.length; i++) {
            var sv = sizeValues[i];
            ids.push(sv.getValue());
            names.push(sv.getDisplayValue());
        }
    } catch (e) { /* no variation model — simple product */ }
    return { ids: ids.join('|'), names: names.join('|') };
}

// Flush batch at 800KB — leaves 200KB headroom under B2C's 1MB JS string quota.
var BATCH_SIZE_LIMIT = 800000;

/**
 * Iterates all online site products and calls uploadFn for each batch.
 * Batches by character count to reliably stay under B2C Commerce's 1MB JS string quota.
 * @param {Function} uploadFn - called with (csvBatch) for each batch
 * @returns {number} total products exported
 */
function uploadProductsInBatches(uploadFn) {
    var allProducts = ProductMgr.queryAllSiteProducts();
    var batchRows   = [CSV_HEADER];
    var batchSize   = CSV_HEADER.length;
    var total       = 0;
    var skipped     = 0;

    try {
        while (allProducts.hasNext()) {
            var product = allProducts.next();

            if (!product.isOnline()) { skipped++; continue; }
            if (!product.getName()) { skipped++; continue; }

            var productId = product.getID();

            var shortDesc = product.getShortDescription() ? product.getShortDescription().toString() : '';
            var longDesc  = product.getLongDescription()  ? product.getLongDescription().toString()  : '';

            var inStock = false;
            try {
                var availModel = product.getAvailabilityModel();
                inStock = availModel ? availModel.isInStock() : false;
            } catch (e) {
                inStock = false;
            }

            // Algolia-parity fields
            var gender    = ('gender' in product.custom && !empty(product.custom.gender) && product.custom.gender.value !== '-None-') ? product.custom.gender.value : '';
            var lifestyle = ('lifestyle' in product.custom && !empty(product.custom.lifestyle)) ? product.custom.lifestyle.displayValue || String(product.custom.lifestyle) : '';
            var jibbitable   = ('jibbitable' in product.custom && product.custom.jibbitable) ? 'true' : 'false';
            var hideFromSearch = product.isSearchable() ? 'false' : 'true';
            var categoryIDs    = getCategoryIDs(product);
            var flatCategories = getFlatCategories(product);
            var snipesLabel = ('snipeValue' in product.custom && !empty(product.custom.snipeValue) && !empty(product.custom.snipeValue.displayValue)) ? product.custom.snipeValue.displayValue : '';
            var snipesColor = '';
            if ('snipeValue' in product.custom && !empty(product.custom.snipeValue) && !empty(product.custom.snipeValue.value)) {
                var snipeParts = product.custom.snipeValue.value.split('|');
                snipesColor = snipeParts.length > 1 ? snipeParts[1] : '';
            }
            var pricing        = getPricing(product);
            var refinementColor  = ('refinementColor' in product.custom && !empty(product.custom.refinementColor)) ? product.custom.refinementColor.displayValue || String(product.custom.refinementColor) : '';
            var refinementSizes  = ('refinementSize' in product.custom && !empty(product.custom.refinementSize)) ? String(product.custom.refinementSize) : '';
            var refinementJibbitz = ('refinementJibbitz' in product.custom && !empty(product.custom.refinementJibbitz)) ? product.custom.refinementJibbitz.displayValue || String(product.custom.refinementJibbitz) : '';
            var sizeVars = getSizeVariations(product);

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
                csvEscape(product.getManufacturerName()),
                csvEscape(inStock),
                csvEscape(gender),
                csvEscape(lifestyle),
                csvEscape(jibbitable),
                csvEscape(hideFromSearch),
                csvEscape(categoryIDs),
                csvEscape(flatCategories),
                csvEscape(snipesLabel),
                csvEscape(snipesColor),
                csvEscape(pricing.price),
                csvEscape(pricing.regularPriceLow),
                csvEscape(pricing.onSale),
                csvEscape(pricing.discountPercentage),
                csvEscape(refinementColor),
                csvEscape(refinementSizes),
                csvEscape(refinementJibbitz),
                csvEscape(sizeVars.ids),
                csvEscape(sizeVars.names)
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

    log.info('Exported: {0}, Skipped (no name or duplicate): {1}', total, skipped);
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
    var connectorName = parameters.ConnectorName;
    var objectName    = 'Product';

    if (!connectorName) {
        log.error('Missing required job parameter ConnectorName');
        return new Status(Status.ERROR, 'MISSING_PARAMS', 'ConnectorName parameter is blank');
    }

    var siteID = Site.getCurrent().getID();
    log.info('Starting product export for site: {0}', siteID);

    // Step 1: Get Data Cloud access token via Client Credentials flow
    var auth;
    try {
        auth = authService.getAccessToken();
        log.info('Authentication successful');
    } catch (e) {
        log.error('Authentication failed: {0}', e.message);
        return new Status(Status.ERROR, 'AUTH_FAILED', e.message);
    }

    var dataCloudInstanceURL = auth.dataCloudInstanceURL;

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
        try {
            ingestionService.abortJob(dataCloudInstanceURL, auth.accessToken, jobId);
            log.info('Aborted orphaned ingestion job: {0}', jobId);
        } catch (abortErr) {
            log.error('Failed to abort job {0}: {1}', jobId, abortErr.message);
        }
        return new Status(Status.ERROR, 'UPLOAD_FAILED', e.message);
    }

    // Step 4: Close job — signals Data Cloud to begin processing asynchronously
    try {
        ingestionService.closeJob(dataCloudInstanceURL, auth.accessToken, jobId);
        log.info('Closed job: {0} Data Cloud will process asynchronously. Check Data Cloud ingestion logs for final status.', jobId);
    } catch (e) {
        log.error('Failed to close job: {0}', e.message);
        return new Status(Status.ERROR, 'CLOSE_JOB_FAILED', e.message);
    }

     return new Status(Status.OK);

    // // Step 5: Poll until JobComplete or Failed
    // var finalState;
    // try {
    //     finalState = ingestionService.waitForJobCompletion(dataCloudInstanceURL, auth.accessToken, jobId);
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
