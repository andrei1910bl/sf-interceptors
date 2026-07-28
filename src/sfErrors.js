const DEFAULT_ERROR_MESSAGE = 'Something wrong';

const STATUS_MESSAGES = {
    400: 'Bad Request — invalid or missing data',
    401: 'Unauthorized — invalid or expired session',
    403: 'Forbidden — insufficient permissions',
    404: 'Not Found — record or endpoint does not exist',
    409: 'Conflict — duplicate or conflicting record',
    429: 'Too Many Requests — API limit exceeded',
    500: 'Internal Server Error — Salesforce server error',
    503: 'Service Unavailable — Salesforce is temporarily unavailable'
};

function resolveErrorMessage(status, primary) {
    const code = primary?.errorCode;

    switch (code) {
        case 'REQUIRED_FIELD_MISSING':
        case 'DUPLICATE_DETECTED':
        case 'INVALID_SESSION_ID':
        case 'NOT_FOUND':
        case 'INSUFFICIENT_ACCESS_OR_READONLY':
        case 'REQUEST_LIMIT_EXCEEDED':
            return primary.message || STATUS_MESSAGES[status] || DEFAULT_ERROR_MESSAGE;
    }

    if (!code) {
        switch (status) {
            case 400:
            case 401:
            case 403:
            case 404:
            case 409:
            case 429:
            case 500:
            case 503:
                return STATUS_MESSAGES[status];
        }
    }

    return DEFAULT_ERROR_MESSAGE;
}

export function parseSalesforceErrors(data) {
    if (Array.isArray(data)) {
        return data.map((item) => ({
            errorCode: item.errorCode,
            message: item.message,
            fields: item.fields || []
        }));
    }

    if (data && typeof data === 'object') {
        if (data.error || data.error_description) {
            return [{
                errorCode: data.error || 'OAUTH_ERROR',
                message: data.error_description || data.message || 'OAuth error'
            }];
        }

        if (data.message || data.errorCode) {
            return [{
                errorCode: data.errorCode || 'UNKNOWN_ERROR',
                message: data.message || 'Unknown Salesforce error',
                fields: data.fields || []
            }];
        }
    }

    if (typeof data === 'string' && data.length > 0) {
        return [{ errorCode: 'UNKNOWN_ERROR', message: data }];
    }

    return [];
}

export function buildSalesforceError(error) {
    if (!error.response) {
        return {
            status: 502,
            body: {
                success: false,
                source: 'integration',
                error: 'NETWORK_ERROR',
                message: error.message || 'Failed to reach Salesforce'
            }
        };
    }

    const { status, data } = error.response;
    const errors = parseSalesforceErrors(data);
    const primary = errors[0];

    return {
        status,
        body: {
            success: false,
            source: 'salesforce',
            status,
            error: primary?.errorCode || `HTTP_${status}`,
            message: resolveErrorMessage(status, primary),
            errors: errors.length > 0 ? errors : undefined
        }
    };
}

export function logSalesforceError(status, errors) {
    const summary = STATUS_MESSAGES[status] || `HTTP ${status}`;

    if (errors.length === 0) {
        console.error(`[Salesforce ${status}] ${summary}`);
        return;
    }

    for (const item of errors) {
        const fields = item.fields?.length ? ` | Fields: ${item.fields.join(', ')}` : '';
        console.error(
            `[Salesforce ${status}] ${item.errorCode}: ${item.message}${fields}`
        );
    }
}

export function handleHttpStatus(status, errors) {
    switch (status) {
        case 400:
            console.warn('Validation or malformed request.');
            break;
        case 401:
            console.warn('Authentication failed or session expired.');
            break;
        case 403:
            console.warn('User lacks permission for this operation.');
            break;
        case 404:
            console.warn('Requested Salesforce resource was not found.');
            break;
        case 409:
            console.warn('Conflict — duplicate or overlapping data.');
            break;
        case 429:
            console.warn('Salesforce API rate limit reached.');
            break;
        case 500:
        case 503:
            console.error('Salesforce service error.');
            break;
        default:
            if (status >= 400) {
                console.warn(DEFAULT_ERROR_MESSAGE);
            }
    }

    for (const item of errors) {
        switch (item.errorCode) {
            case 'REQUIRED_FIELD_MISSING':
                console.warn('Required field missing in payload.');
                break;
            case 'DUPLICATE_DETECTED':
                console.warn('Duplicate rules blocked this request.');
                break;
            case 'INVALID_SESSION_ID':
                console.warn('Session is invalid or expired.');
                break;
            case 'NOT_FOUND':
                console.warn('Salesforce record or endpoint not found.');
                break;
            case 'INSUFFICIENT_ACCESS_OR_READONLY':
                console.warn('Insufficient access to perform this action.');
                break;
            case 'REQUEST_LIMIT_EXCEEDED':
                console.warn('Salesforce request limit exceeded.');
                break;
            default:
                console.warn(DEFAULT_ERROR_MESSAGE);
        }
    }
}
