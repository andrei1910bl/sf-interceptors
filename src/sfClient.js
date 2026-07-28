import axios from 'axios';
import dotenv from 'dotenv';
import {
    buildSalesforceError,
    handleHttpStatus,
    logSalesforceError,
    parseSalesforceErrors
} from './sfErrors.js';

dotenv.config();

let accessToken = process.env.SF_ACCESS_TOKEN || null;
let instanceUrl = process.env.SF_INSTANCE_URL || null;

export function getInstanceUrl() {
    return instanceUrl;
}

async function loginToSalesforce() {
    try {
        const response = await axios.post(`${process.env.SF_LOGIN_URL}/services/oauth2/token`, null, {
            params: {
                grant_type: 'password',
                client_id: process.env.SF_CLIENT_ID,
                client_secret: process.env.SF_CLIENT_SECRET,
                username: process.env.SF_USERNAME,
                password: process.env.SF_PASSWORD
            }
        });

        accessToken = response.data.access_token;
        instanceUrl = response.data.instance_url;
        console.log('Successfully authenticated with Salesforce.');
    } catch (error) {
        const formatted = buildSalesforceError(error);
        console.error('Salesforce Authentication Failed:', formatted.body);
        throw Object.assign(new Error(formatted.body.message), { salesforce: formatted });
    }
}

const sfClient = axios.create();

sfClient.interceptors.request.use(
    async (config) => {
        if (!accessToken) {
            await loginToSalesforce();
        }

        config.baseURL = instanceUrl;
        config.headers['Authorization'] = `Bearer ${accessToken}`;
        config.headers['Content-Type'] = 'application/json';

        return config;
    },
    (error) => Promise.reject(error)
);

sfClient.interceptors.response.use(
    (response) => response,
    async (error) => {
        const originalRequest = error.config;

        if (error.response) {
            const { status, data } = error.response;
            const errors = parseSalesforceErrors(data);

            logSalesforceError(status, errors);
            handleHttpStatus(status, errors);

            error.salesforce = buildSalesforceError(error);

            const sessionExpired = status === 401
                || errors.some((item) => item.errorCode === 'INVALID_SESSION_ID');

            if (sessionExpired && originalRequest && !originalRequest._retry) {
                originalRequest._retry = true;
                console.log('Session expired. Attempting to refresh token...');
                accessToken = null;
                await loginToSalesforce();
                originalRequest.headers['Authorization'] = `Bearer ${accessToken}`;
                originalRequest.baseURL = instanceUrl;
                return sfClient(originalRequest);
            }
        } else {
            console.error('[Network Error]:', error.message);
            error.salesforce = buildSalesforceError(error);
        }

        return Promise.reject(error);
    }
);

export default sfClient;
