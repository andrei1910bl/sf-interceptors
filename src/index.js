import express from 'express';
import dotenv from 'dotenv';
import sfClient, { getInstanceUrl } from './sfClient.js';
import { buildSalesforceError } from './sfErrors.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

function buildPaymentsPayload(body) {
    if (Array.isArray(body.payments)) {
        return { payments: body.payments };
    }

    return {
        payments: [{
            Opportunity: body.Opportunity,
            Amount: body.Amount,
            FirstName: body.FirstName,
            LastName: body.LastName
        }]
    };
}

function validatePaymentsPayload(payload) {
    if (!Array.isArray(payload.payments) || payload.payments.length === 0) {
        return 'Request body must contain a non-empty "payments" array or payment fields';
    }

    for (const [index, payment] of payload.payments.entries()) {
        if (!payment.Opportunity) {
            return `Payment at index ${index} is missing required field "Opportunity"`;
        }
    }

    return null;
}

app.get('/health', (_req, res) => {
    res.status(200).json({
        success: true,
        service: 'sf-interceptors',
        salesforceInstance: getInstanceUrl() || null
    });
});

app.post('/payments', async (req, res) => {
    const payload = buildPaymentsPayload(req.body);
    const validationError = validatePaymentsPayload(payload);

    if (validationError) {
        return res.status(400).json({
            success: false,
            source: 'integration',
            status: 400,
            error: 'VALIDATION_ERROR',
            message: validationError
        });
    }

    console.log('Forwarding payment request to Salesforce:', JSON.stringify(payload, null, 2));

    try {
        const response = await sfClient.post('/services/apexrest/payments/', payload);

        return res.status(response.status).json({
            success: true,
            source: 'salesforce',
            status: response.status,
            data: response.data
        });
    } catch (error) {
        const formatted = error.salesforce || buildSalesforceError(error);
        return res.status(formatted.status).json(formatted.body);
    }
});

app.use((_req, res) => {
    res.status(404).json({
        success: false,
        source: 'integration',
        status: 404,
        error: 'NOT_FOUND',
        message: 'Endpoint not found'
    });
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`POST http://localhost:${PORT}/payments`);
});
