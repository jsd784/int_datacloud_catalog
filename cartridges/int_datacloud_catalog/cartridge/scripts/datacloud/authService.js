'use strict';

var LocalServiceRegistry = require('dw/svc/LocalServiceRegistry');
var HTTPClient            = require('dw/net/HTTPClient');

var SERVICE_ID = 'int_datacloud.auth';

/**
 * Gets the OAuth service registered in BM → Operations → Services.
 * Credential: URL = Salesforce Core My Domain URL. OIC fields: Consumer Key → credential.custom.consumerKey, Consumer Secret → credential.custom.consumerSecret.
 */
function getOAuthService() {
    return LocalServiceRegistry.createService(SERVICE_ID, {
        createRequest: function (svc, params) {
            var credential = svc.getConfiguration().getCredential();
            if (!credential) {
                throw new Error('Service credential not configured — assign a credential to service "' + SERVICE_ID + '" in BM → Operations → Services');
            }

            var clientId     = credential.custom.consumerKey;
            var clientSecret = credential.custom.consumerSecret;
            if (!clientId || !clientSecret) {
                throw new Error('Service credential "' + credential.getID() + '" is missing Consumer Key or Consumer Secret');
            }

            var baseURL = credential.getURL();
            if (!baseURL) {
                throw new Error('Service credential "' + credential.getID() + '" has no URL — set it to the Salesforce Core My Domain URL');
            }
            if (baseURL.charAt(baseURL.length - 1) === '/') {
                baseURL = baseURL.substring(0, baseURL.length - 1);
            }

            svc.setURL(baseURL + '/services/oauth2/token');
            svc.setRequestMethod('POST');
            svc.addHeader('Content-Type', 'application/x-www-form-urlencoded');

            return 'grant_type=client_credentials'
                + '&client_id='     + encodeURIComponent(clientId)
                + '&client_secret=' + encodeURIComponent(clientSecret);
        },
        parseResponse: function (svc, httpClient) {
            return JSON.parse(httpClient.text);
        },
        filterLogMessage: function (msg) {
            return msg.replace(/client_secret=[^&\s]+/, 'client_secret=***');
        }
    });
}

/**
 * Gets a Data Cloud access token using Client Credentials flow.
 *
 * Step 1: Client Credentials POST to Salesforce Core → Core access token
 * Step 2: Exchange Core token for Data Cloud token via /services/a360/token
 *
 * Service 'int_datacloud.auth' must be configured in BM → Operations → Services.
 * See README for credential setup instructions.
 *
 * @returns {{ accessToken: string, dataCloudInstanceURL: string }}
 */
function getAccessToken() {
    // Step 1: Client Credentials → Salesforce Core token
    var svc    = getOAuthService();
    var result = svc.call();

    if (!result.isOk()) {
        throw new Error('Auth failed: ' + result.errorMessage);
    }

    var sfResponse = result.object;
    if (!sfResponse.access_token) {
        throw new Error('Auth response missing access_token');
    }
    if (!sfResponse.instance_url) {
        throw new Error('Auth response missing instance_url — check that the Salesforce Core My Domain URL is correct in the service credential');
    }

    // Step 2: Exchange Core token for Data Cloud token
    var dcClient = new HTTPClient();
    dcClient.setTimeout(10000);
    dcClient.open('POST', sfResponse.instance_url + '/services/a360/token');
    dcClient.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');

    dcClient.send('grant_type=urn%3Asalesforce%3Agrant-type%3Aexternal%3Acdp'
        + '&subject_token=' + encodeURIComponent(sfResponse.access_token)
        + '&subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token');

    var dcBody = dcClient.text || dcClient.errorText || '(empty)';
    if (dcClient.statusCode !== 200) {
        throw new Error('DC token exchange failed [' + dcClient.statusCode + ']: ' + dcBody);
    }

    var dcResponse = JSON.parse(dcBody);
    if (dcResponse.error) {
        throw new Error('DC token exchange error: ' + dcResponse.error + ' - ' + dcResponse.error_description);
    }

    var instanceURL = dcResponse.instance_url;
    if (instanceURL && instanceURL.indexOf('https://') !== 0) {
        instanceURL = 'https://' + instanceURL;
    }

    return {
        accessToken:          dcResponse.access_token,
        dataCloudInstanceURL: instanceURL
    };
}

module.exports = { getAccessToken: getAccessToken };
