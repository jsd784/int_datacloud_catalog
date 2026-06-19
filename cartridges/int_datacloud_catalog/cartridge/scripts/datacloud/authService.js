'use strict';

var HTTPClient = require('dw/net/HTTPClient');
var Signature  = require('dw/crypto/Signature');
var KeyRef     = require('dw/crypto/KeyRef');

var TOKEN_ENDPOINT = '/services/oauth2/token';
var B64_CHARS      = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64UrlEncode(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 128) {
            bytes.push(c);
        } else if (c < 2048) {
            bytes.push((c >> 6) | 192);
            bytes.push((c & 63) | 128);
        } else {
            bytes.push((c >> 12) | 224);
            bytes.push(((c >> 6) & 63) | 128);
            bytes.push((c & 63) | 128);
        }
    }
    var result = '';
    var len = bytes.length;
    for (var j = 0; j < len; j += 3) {
        var b0 = bytes[j] & 0xFF;
        var b1 = (j + 1 < len) ? (bytes[j + 1] & 0xFF) : 0;
        var b2 = (j + 2 < len) ? (bytes[j + 2] & 0xFF) : 0;
        result += B64_CHARS.charAt(b0 >> 2);
        result += B64_CHARS.charAt(((b0 & 3) << 4) | (b1 >> 4));
        result += (j + 1 < len) ? B64_CHARS.charAt(((b1 & 15) << 2) | (b2 >> 6)) : '=';
        result += (j + 2 < len) ? B64_CHARS.charAt(b2 & 63) : '=';
    }
    return result.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Signs a JWT using RS256 via dw.crypto.Signature and dw.crypto.KeyRef.
 * The private key must be imported in Business Manager →
 * Administration → Operations → Private Keys and Certificates.
 *
 * @param {string} consumerKey   - External Client App consumer key
 * @param {string} username      - Salesforce username pre-authorized on the app
 * @param {string} audience      - JWT audience (https://test.salesforce.com for sandbox)
 * @param {string} privateKeyAlias - Alias of the key in BM certificate store
 * @returns {string} signed JWT assertion
 */
function signJWT(consumerKey, username, audience, privateKeyAlias) {
    var header  = { alg: 'RS256', typ: 'JWT' };
    var nowSecs = Math.floor(new Date().getTime() / 1000);
    var payload = {
        iss: consumerKey,
        sub: username,
        aud: audience,
        exp: nowSecs + 180
    };

    var headerEncoded  = base64UrlEncode(JSON.stringify(header));
    var payloadEncoded = base64UrlEncode(JSON.stringify(payload));
    var signingInput   = headerEncoded + '.' + payloadEncoded;

    var StringUtils       = require('dw/util/StringUtils');
    var base64SigningInput = StringUtils.encodeBase64(signingInput);

    var privateKeyRef   = new KeyRef(privateKeyAlias);
    var signer          = new Signature();
    var rawSignature    = signer.sign(base64SigningInput, privateKeyRef, 'SHA256withRSA');
    var signatureB64Url = rawSignature.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    return signingInput + '.' + signatureB64Url;
}

/**
 * Gets a Data Cloud access token using JWT Bearer flow.
 *
 * Step 1: POST JWT to Salesforce Core token endpoint → get Core access token
 * Step 2: Exchange Core token for Data Cloud token via /services/a360/token
 *
 * @param {string} loginURL        - Salesforce My Domain URL (e.g. https://yourorg.sandbox.my.salesforce.com)
 * @param {string} consumerKey     - External Client App consumer key
 * @param {string} username        - Salesforce username pre-authorized on the app
 * @param {string} privateKeyAlias - Alias of the private key in BM certificate store
 * @returns {{ accessToken: string }}
 */
function getAccessToken(loginURL, consumerKey, username, privateKeyAlias) {
    var jwt = signJWT(consumerKey, username, 'https://test.salesforce.com', privateKeyAlias);

    var client = new HTTPClient();
    client.setTimeout(10000);
    client.open('POST', loginURL + TOKEN_ENDPOINT);
    client.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');

    var body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer'
             + '&assertion=' + encodeURIComponent(jwt);
    client.send(body);

    var responseBody = client.text || client.errorText || '(empty)';
    if (client.statusCode !== 200) {
        throw new Error('Auth failed [' + client.statusCode + ']: ' + responseBody);
    }

    var sfResponse = JSON.parse(responseBody);
    if (!sfResponse.access_token) {
        throw new Error('Auth response missing access_token: ' + responseBody);
    }

    // Exchange Salesforce Core token for Data Cloud token
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

    return {
        accessToken: dcResponse.access_token
    };
}

module.exports = { getAccessToken: getAccessToken };
