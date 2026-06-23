'use strict';

var HTTPClient = require('dw/net/HTTPClient');
var Logger     = require('dw/system/Logger');

var log       = Logger.getLogger('int_datacloud_catalog', 'ingestionService');
var BASE_PATH = '/api/v1/ingest';

/**
 * Creates a bulk ingestion job in Data Cloud.
 * @param {string} instanceURL    - Data Cloud instance URL (from auth token response)
 * @param {string} accessToken    - Bearer token
 * @param {string} connectorName  - Ingestion API connector name configured in Data Cloud Setup
 * @param {string} objectName     - Schema object name (e.g. "Product")
 * @returns {string} jobId
 */
function createJob(instanceURL, accessToken, connectorName, objectName) {
    var client = new HTTPClient();
    client.setTimeout(15000);
    client.open('POST', instanceURL + BASE_PATH + '/jobs');
    client.setRequestHeader('Authorization', 'Bearer ' + accessToken);
    client.setRequestHeader('Content-Type', 'application/json');
    client.send(JSON.stringify({ object: objectName, sourceName: connectorName, operation: 'upsert' }));

    var responseBody = client.text || client.errorText || '(empty)';
    if (client.statusCode !== 201) {
        throw new Error('createJob failed [' + client.statusCode + ']: ' + responseBody);
    }

    return JSON.parse(client.text).id;
}

/**
 * Uploads CSV data to an open bulk job.
 * @param {string} instanceURL  - Data Cloud instance URL
 * @param {string} accessToken  - Bearer token
 * @param {string} jobId        - Job ID from createJob
 * @param {string} csvData      - CSV string with header row
 */
function uploadJobData(instanceURL, accessToken, jobId, csvData) {
    var client = new HTTPClient();
    client.setTimeout(30000);
    client.open('PUT', instanceURL + BASE_PATH + '/jobs/' + jobId + '/batches');
    client.setRequestHeader('Authorization', 'Bearer ' + accessToken);
    client.setRequestHeader('Content-Type', 'text/csv');
    client.send(csvData);

    if (client.statusCode !== 202) {
        throw new Error('uploadJobData failed [' + client.statusCode + ']: ' + (client.text || client.errorText));
    }
}

/**
 * Closes a job so Data Cloud begins processing the uploaded data.
 * @param {string} instanceURL  - Data Cloud instance URL
 * @param {string} accessToken  - Bearer token
 * @param {string} jobId        - Job ID from createJob
 */
function closeJob(instanceURL, accessToken, jobId) {
    var client = new HTTPClient();
    client.setTimeout(15000);
    client.open('PATCH', instanceURL + BASE_PATH + '/jobs/' + jobId);
    client.setRequestHeader('Authorization', 'Bearer ' + accessToken);
    client.setRequestHeader('Content-Type', 'application/json');
    client.send(JSON.stringify({ state: 'UploadComplete' }));

    if (client.statusCode !== 200) {
        throw new Error('closeJob failed [' + client.statusCode + ']: ' + (client.text || client.errorText));
    }
}

/**
 * Polls job status until JobComplete or terminal state (max 10 minutes).
 * @param {string} instanceURL  - Data Cloud instance URL
 * @param {string} accessToken  - Bearer token
 * @param {string} jobId        - Job ID to poll
 * @returns {string} Final job state
 */
function waitForJobCompletion(instanceURL, accessToken, jobId) {
    var MAX_ATTEMPTS   = 120; // 120 × 5s = 10 minutes max
    var terminalStates = ['JobComplete', 'Failed', 'Aborted'];

    for (var i = 0; i < MAX_ATTEMPTS; i++) {
        var client = new HTTPClient();
        client.setTimeout(10000);
        client.open('GET', instanceURL + BASE_PATH + '/jobs/' + jobId);
        client.setRequestHeader('Authorization', 'Bearer ' + accessToken);
        client.send();

        if (client.statusCode !== 200) {
            throw new Error('getJobInfo failed [' + client.statusCode + ']: ' + (client.text || client.errorText));
        }

        var state = JSON.parse(client.text).state;
        log.info('Polling Data Cloud — Attempt {0}/{1} — Status: {2}', (i + 1), MAX_ATTEMPTS, state);

        if (terminalStates.indexOf(state) !== -1) {
            return state;
        }

        if (i < MAX_ATTEMPTS - 1) {
            localSleep(5000);
        }
    }

    return 'Unknown';
}

// dw.Thread.sleep() is unavailable in B2C Commerce's Rhino engine — busy-wait instead
function localSleep(milliseconds) {
    var startTime = new Date().getTime();
    while (new Date().getTime() < startTime + milliseconds) { /* spin */ }
}

module.exports = {
    createJob:            createJob,
    uploadJobData:        uploadJobData,
    closeJob:             closeJob,
    waitForJobCompletion: waitForJobCompletion
};
