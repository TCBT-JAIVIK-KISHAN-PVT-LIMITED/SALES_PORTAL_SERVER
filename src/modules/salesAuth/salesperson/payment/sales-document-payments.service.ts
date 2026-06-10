import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as crypto from 'crypto';
import { Request } from 'express';
import {
  SalesDocument,
  SalesDocumentType,
} from '../../models/sales-document.schema';
import { ZohoPaymentGatewayService } from '../../../../integrations/payments/zoho-payment-gateway.service';
import { ZohoPaymentLinksService } from '../../../../integrations/payments/zoho-payment-links.service';
import { OrdersService } from '../../salesOrders/orders.service';

@Injectable()
export class SalesDocumentPaymentsService {
  constructor(
    @InjectModel(SalesDocument.name)
    private readonly salesDocumentModel: Model<SalesDocument>,
    private readonly zohoPaymentGateway: ZohoPaymentGatewayService,
    private readonly zohoPaymentLinksService: ZohoPaymentLinksService,
    private readonly configService: ConfigService,
    private readonly salesOrdersService: OrdersService,
  ) {}

  private verifySignature(rawBody: Buffer, timestamp: string, receivedV: string, secret: string): boolean {
    if (!receivedV) {
      // No signature at all (ping/test from Zoho)
      return false;
    }

    // ✅ CONFIRMED algorithm: HMAC-SHA256(secret, timestamp + "." + rawBody) in hex
    if (timestamp) {
      const message = Buffer.concat([Buffer.from(timestamp + '.'), rawBody]);
      const computed = crypto.createHmac('sha256', secret).update(message).digest('hex');
      if (computed.toLowerCase() === receivedV.toLowerCase()) return true;
    }

    // Fallback: HMAC-SHA256(secret, rawBody) in hex
    const fallback = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return fallback.toLowerCase() === receivedV.toLowerCase();
  }

  async createOnlinePaymentForSalesDocument(params: {
    salespersonId: string;
    documentNumber: string;
  }) {
    const doc = await this.salesDocumentModel.findOne({
      salesperson_id: params.salespersonId,
      documentNumber: params.documentNumber,
    });

    if (!doc) throw new BadRequestException('Sales document not found');
    if (doc.type !== 'quotation') {
      throw new BadRequestException(
        'Online payment can be started only for quotations',
      );
    }

    if (doc.paymentStatus === 'paid') {
      return { alreadyPaid: true, documentNumber: doc.documentNumber };
    }

    const session = await this.zohoPaymentGateway.createPaymentSession({
      finalAmount: Number(doc.grandTotal || 0),
      orderId: doc.documentNumber,
    });

    await this.salesDocumentModel.updateOne(
      {
        salesperson_id: params.salespersonId,
        documentNumber: params.documentNumber,
      },
      {
        $set: {
          paymentStatus: 'unpaid',
          paymentMethod: 'online',
          onlinePaymentSessionId: session?.payments_session_id || session?.id,
        },
      },
    );

    const paymentUrl =
      session?.payment_url || session?.paymentUrl || session?.payment_link;

    return {
      paymentSessionId:
        session?.payments_session_id ||
        session?.id ||
        session?.payments_session_id,
      paymentUrl,
    };
  }

  async createPaymentLinkForQuotation(params: {
    quotationId: string;
    farmerName: string;
    farmerPhone: string;
    amount: number;
    description?: string;
    salespersonId?: string;
  }) {
    const { quotationId, farmerName, farmerPhone, amount, description } = params;

    if (!quotationId || typeof quotationId !== 'string') {
      throw new BadRequestException('quotationId is required');
    }

    if (!farmerName || typeof farmerName !== 'string') {
      throw new BadRequestException('farmerName is required');
    }

    if (!/^[0-9]{10}$/.test(String(farmerPhone))) {
      throw new BadRequestException('farmerPhone must be a valid 10-digit number');
    }

    const finalAmount = Number(amount);
    if (Number.isNaN(finalAmount) || finalAmount <= 0) {
      throw new BadRequestException('amount must be a positive number');
    }

    const search: any = { documentNumber: quotationId };
    if (params.salespersonId) {
      search.salesperson_id = params.salespersonId;
    }

    const doc = await this.salesDocumentModel.findOne(search);
    if (!doc) {
      throw new BadRequestException('Quotation not found');
    }

    if (doc.type !== 'quotation') {
      throw new BadRequestException(
        'Payment links can only be generated for quotations',
      );
    }

    const normalizedPhone = String(farmerPhone || '').trim();
    const digits = normalizedPhone.replace(/\D/g, '');
    const phone =
      digits.length === 10
        ? digits
        : digits.length === 11 && digits.startsWith('0')
        ? digits.slice(1)
        : digits.length === 12 && digits.startsWith('91')
        ? digits.slice(2)
        : normalizedPhone;

    let session: any;
    try {
      session = await this.zohoPaymentLinksService.createPaymentLink({
        quotationId: quotationId,
        farmerName: farmerName,
        farmerPhone: phone,
        amount: finalAmount,
        description: description || `Payment for ${quotationId}`,
      });
    } catch (error: unknown) {
      console.error('Failed to generate Zoho payment link', error);
      throw new BadRequestException(
        'Failed to generate payment link. Check Zoho payment configuration.',
      );
    }

    const paymentLinks = this.extractPaymentLink(session);
    const paymentUrl =
      paymentLinks?.url || paymentLinks?.payment_url || paymentLinks?.paymentLink ||
      session?.url || session?.link;

    if (!paymentUrl) {
      console.error('Zoho response missing payment URL', JSON.stringify(session));
      throw new BadRequestException('Failed to generate payment link');
    }

    const expiresAt =
      paymentLinks?.expires_at ||
      new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString().split('T')[0];

    const expiresAtFormatted = new Date(expiresAt).toLocaleString('en-US', {
      month: 'short',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });

    const paymentLinkId =
      paymentLinks?.payment_link_id ||
      paymentLinks?.id ||
      session?.payment_link_id ||
      null;

    await this.salesDocumentModel.updateOne(
      { _id: doc._id },
      {
        $set: {
          onlinePaymentUrl: paymentUrl,
          onlinePaymentExpiresAt: expiresAt,
          onlinePaymentSessionId: null,
          onlinePaymentLinkId: paymentLinkId,
          paymentStatus: 'unpaid',
          paymentMethod: 'online',
        },
      },
    );

    return {
      code: 0,
      message: 'Payment link generated',
      payment_links: {
        payment_link_id:
          paymentLinks?.payment_link_id ||
          paymentLinks?.id ||
          session?.payment_link_id ||
          null,
        url: paymentUrl,
        expires_at: expiresAt,
        expires_at_formatted:
          paymentLinks?.expires_at_formatted || expiresAtFormatted,
        amount: finalAmount.toFixed(2),
        currency: paymentLinks?.currency || session?.currency || 'INR',
        status: paymentLinks?.status || session?.status || 'active',
        reference_id: quotationId,
        description: description || paymentLinks?.description || session?.description || '',
        phone,
      },
    };
  }

  async handleZohoWebhook(req: Request) {
    console.log('\n----- [SalesDocWebhook] handleZohoWebhook START -----');
    console.log('[SalesDocWebhook] Headers received:', JSON.stringify(req.headers, null, 2));

    // Zoho sends signature as 'x-zoho-webhook-signature: t=<ts>,v=<hex>'
    const sigHeader = (req.headers['x-zoho-webhook-signature'] as string) || '';
    const timestamp = sigHeader.match(/t=(\d+)/)?.[1] ?? '';
    const receivedV = sigHeader.match(/v=([a-f0-9]+)/i)?.[1] ?? '';
    console.log('[SalesDocWebhook] Signature header:', sigHeader || '❌ MISSING');
    console.log('[SalesDocWebhook] Parsed timestamp:', timestamp || '❌ MISSING');
    console.log('[SalesDocWebhook] Parsed v:', receivedV || '❌ MISSING');

    const secret = this.configService.getOrThrow<string>('ZOHO_PAYMENTS_SIGNING_KEY');
    console.log('[SalesDocWebhook] Secret (first 10):', secret?.slice(0, 10) + '...');

    const anyReq = req as any;
    const rawBody: Buffer | undefined = anyReq.rawBody || anyReq.body;
    console.log('[SalesDocWebhook] rawBody present?', !!rawBody, '| is Buffer?', rawBody instanceof Buffer, '| length:', rawBody?.length ?? 0);

    if (!rawBody || !(rawBody instanceof Buffer)) {
      console.error('[SalesDocWebhook] ❌ Missing or non-Buffer raw body — rejecting');
      throw new UnauthorizedException('Missing raw body');
    }

    const rawBodyStr = rawBody.toString();
    console.log('[SalesDocWebhook] Raw body:', rawBodyStr);

    const sigOk = this.verifySignature(rawBody, timestamp, receivedV, secret);
    console.log('[SalesDocWebhook] Signature valid?', sigOk);

    if (!sigOk) {
      console.error('[SalesDocWebhook] ❌ Invalid signature — rejecting');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBodyStr);
      console.log('[SalesDocWebhook] Parsed payload:', JSON.stringify(payload, null, 2));
    } catch (e: any) {
      console.error('[SalesDocWebhook] ❌ JSON parse error:', e.message);
      return { received: true };
    }

    const eventType = payload.event_type;
    const eventObject = payload.event_object;
    const payment = eventObject?.payment;
    const paymentLink = this.extractPaymentLink(eventObject);

    console.log('[SalesDocWebhook] event_type:', eventType);
    console.log('[SalesDocWebhook] event_object keys:', Object.keys(eventObject || {}));
    console.log('[SalesDocWebhook] payment:', JSON.stringify(payment, null, 2));
    console.log('[SalesDocWebhook] paymentLink extracted:', JSON.stringify(paymentLink, null, 2));

    const paymentId =
      payment?.payment_id ||
      paymentLink?.payment_id ||
      paymentLink?.payment_link_id;
    const amount =
      payment?.amount ||
      paymentLink?.amount ||
      paymentLink?.amount_paid;

    // Zoho sends QT number in description ("Payment for quotation QT-xxx"), not in reference_number
    const referenceNumber =
      payment?.reference_number ||
      payment?.reference_id ||
      paymentLink?.reference_id ||
      payment?.description?.match(/(QT-[\w-]+)/)?.[1] ||
      paymentLink?.description?.match(/(QT-[\w-]+)/)?.[1];

    // payment_link_id from Zoho matches our stored onlinePaymentLinkId
    const zohoPaymentLinkId = payment?.payment_link_id || paymentLink?.payment_link_id || paymentLink?.id;

    console.log('[SalesDocWebhook] Extracted:', { paymentId, amount, referenceNumber, zohoPaymentLinkId });

    if (!referenceNumber && !zohoPaymentLinkId) {
      console.warn('[SalesDocWebhook] ⚠️ No referenceNumber or paymentLinkId found — ignoring');
      return { received: true };
    }

    // Try finding doc by documentNumber first, then by onlinePaymentLinkId
    let doc = referenceNumber
      ? await this.salesDocumentModel.findOne({ documentNumber: referenceNumber })
      : null;

    if (!doc && zohoPaymentLinkId) {
      console.log('[SalesDocWebhook] Trying lookup by onlinePaymentLinkId:', zohoPaymentLinkId);
      doc = await this.salesDocumentModel.findOne({ onlinePaymentLinkId: zohoPaymentLinkId });
    }

    console.log(
      '[SalesDocWebhook] SalesDocument lookup:',
      doc
        ? `✅ FOUND (type: ${doc.type}, paymentStatus: ${doc.paymentStatus}, isSyncedToZoho: ${doc.isSyncedToZoho})`
        : '❌ NOT FOUND',
    );


    if (!doc) {
      console.warn('[SalesDocWebhook] ⚠️ No SalesDocument for referenceNumber:', referenceNumber);
      return { received: true };
    }

    const isPaymentSucceeded =
      eventType === 'payment.succeeded' ||
      eventType === 'payment_link.paid' ||
      eventType === 'paymentlink.paid' ||
      this.isPaidPaymentStatus(payment?.status) ||
      this.isPaidPaymentStatus(paymentLink?.status);

    const isPaymentFailed =
      eventType === 'payment.failed' ||
      eventType === 'payment_link.failed' ||
      eventType === 'paymentlink.failed' ||
      this.isFailedPaymentStatus(payment?.status) ||
      this.isFailedPaymentStatus(paymentLink?.status);

    console.log('[SalesDocWebhook] isPaymentSucceeded?', isPaymentSucceeded, '| isPaymentFailed?', isPaymentFailed);

    if (isPaymentSucceeded) {
      console.log('[SalesDocWebhook] ✅ Payment succeeded — updating doc & syncing to Zoho');
      console.log('[SalesDocWebhook] doc.type:', doc.type, '| items count:', doc.items?.length);
      console.log('[SalesDocWebhook] doc.items sample:', JSON.stringify(doc.items?.slice(0, 2)));

      await this.salesDocumentModel.updateOne(
        { _id: doc._id },
        {
          $set: {
            paymentStatus: 'paid',
            paymentMethod: 'online',
            paymentDate: new Date().toISOString().split('T')[0],
            transactionId: paymentId,
          },
        },
      );
      console.log('[SalesDocWebhook] ✅ SalesDocument updated to paid');

      doc.paymentStatus = 'paid';
      doc.paymentMethod = 'online';
      doc.paymentDate = new Date().toISOString().split('T')[0];
      doc.transactionId = paymentId;

      if (doc.type === 'quotation') {
        console.log('[SalesDocWebhook] Converting quotation → invoice & creating Zoho sales order...');
        try {
          await this.convertQuotationToInvoiceAfterPaid({ quotationDoc: doc });
          console.log('[SalesDocWebhook] ✅ Invoice document created in MongoDB');
        } catch (convertErr: any) {
          console.error('[SalesDocWebhook] ❌ convertQuotationToInvoiceAfterPaid FAILED:', convertErr.message);
        }

        try {
          await this.salesOrdersService.createOrUpdatePaidOrderFromQuotation({
            quotation: doc,
            paymentId,
            amount: Number(amount || doc.grandTotal || 0),
          });
          console.log('[SalesDocWebhook] ✅ createOrUpdatePaidOrderFromQuotation done');
        } catch (syncErr: any) {
          console.error('[SalesDocWebhook] ❌ createOrUpdatePaidOrderFromQuotation FAILED:', syncErr.message);
          console.error('[SalesDocWebhook] Stack:', syncErr.stack);
        }
      } else {
        console.log('[SalesDocWebhook] doc.type is not quotation:', doc.type, '— skipping Zoho sync');
      }
    }

    if (isPaymentFailed) {
      console.log('[SalesDocWebhook] ❌ Payment FAILED for referenceNumber:', referenceNumber);
      await this.salesDocumentModel.updateOne(
        { _id: doc._id },
        { $set: { paymentStatus: 'failed', paymentMethod: 'online' } },
      );
    }

    console.log('----- [SalesDocWebhook] handleZohoWebhook END -----\n');
    return { received: true };
  }

  private async convertQuotationToInvoiceAfterPaid(params: {
    quotationDoc: SalesDocument;
  }) {
    const quotation = params.quotationDoc;

    const invoiceDocumentNumber = quotation.documentNumber.replace('QT-', 'INV-');

    const existing = await this.salesDocumentModel.findOne({
      salesperson_id: quotation.salesperson_id,
      type: 'invoice',
      documentNumber: invoiceDocumentNumber,
    });

    if (existing) return;

    const invoicePayload: any = {
      ...quotation.data,
      quoteNumber: invoiceDocumentNumber,
      documentNumber: invoiceDocumentNumber,
      relatedQuotationNumber: quotation.documentNumber,
      type: 'invoice',
      paymentStatus: 'paid',
      paymentMethod: 'online',
      paymentDate: quotation.paymentDate,
      transactionId: quotation.transactionId,
      isSyncedToZoho: quotation.isSyncedToZoho,
      zohoSalesOrderId: quotation.zohoSalesOrderId,
    };

    await this.salesDocumentModel.findOneAndUpdate(
      {
        salesperson_id: quotation.salesperson_id,
        type: 'invoice',
        documentNumber: invoiceDocumentNumber,
      },
      {
        $set: {
          salesperson_id: quotation.salesperson_id,
          salesName: quotation.salesName,
          type: 'invoice',
          documentNumber: invoiceDocumentNumber,
          relatedQuotationNumber: quotation.documentNumber,
          customerName: quotation.customerName,
          customerPhone: quotation.customerPhone,
          subtotal: quotation.subtotal,
          gst: quotation.gst,
          grandTotal: quotation.grandTotal,
          items: quotation.items,
          data: invoicePayload,
          paymentStatus: 'paid',
          paymentMethod: 'online',
          paymentDate: quotation.paymentDate,
          transactionId: quotation.transactionId,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  private async verifyPaymentLinkStatus(paymentLinkId: string): Promise<{
    status: string;
    paymentId: string | null;
    amount: string | null;
  }> {
    try {
      const data = await this.zohoPaymentLinksService.getPaymentLink(paymentLinkId);
      const link = this.extractPaymentLink(data) || data;

      const payments = Array.isArray(link?.payments) ? link.payments : [];
      const succeededPayment = payments.find((p: any) =>
        this.isPaidPaymentStatus(p?.status),
      );

      return {
        status: link?.status ?? 'unknown',
        paymentId:
          succeededPayment?.payment_id ??
          link?.payment_id ??
          link?.payment_link_id ??
          paymentLinkId,
        amount:
          succeededPayment?.amount ??
          link?.amount_paid ??
          link?.amount ??
          null,
      };
    } catch (error) {
      console.error('Failed to verify Zoho payment link status:', error);
      return {
        status: 'unknown',
        paymentId: null,
        amount: null,
      };
    }
  }

  async getPaymentStatus(params: {
    salespersonId: string;
    documentNumber: string;
  }) {
    console.log('[PaymentStatus] Polling payment status for:', params.documentNumber);

    const doc = await this.salesDocumentModel.findOne({
      salesperson_id: params.salespersonId,
      documentNumber: params.documentNumber,
    });

    console.log('[PaymentStatus] Doc found:', doc
      ? `type=${doc.type}, paymentStatus=${doc.paymentStatus}, linkId=${(doc as any).onlinePaymentLinkId || '❌ NONE'}`
      : '❌ NOT FOUND');

    if (!doc) throw new BadRequestException('Sales document not found');

    if (doc.type === 'quotation' && doc.paymentStatus !== 'paid') {
      let result: { status: string; paymentId: string | null; amount: string | null } | null = null;

      if ((doc as any).onlinePaymentLinkId) {
        console.log('[PaymentStatus] Checking Zoho payment link:', (doc as any).onlinePaymentLinkId);
        result = await this.verifyPaymentLinkStatus((doc as any).onlinePaymentLinkId);
        console.log('[PaymentStatus] Zoho link status result:', result);
      } else if (doc.onlinePaymentSessionId) {
        console.log('[PaymentStatus] Checking Zoho payment session:', doc.onlinePaymentSessionId);
        result = await this.zohoPaymentGateway.verifyPaymentSessionStatus(
          doc.onlinePaymentSessionId,
        );
        console.log('[PaymentStatus] Zoho session status result:', result);
      } else {
        console.warn('[PaymentStatus] ⚠️ No onlinePaymentLinkId or onlinePaymentSessionId on doc — cannot poll Zoho');
      }

      if (result && this.isPaidPaymentStatus(result.status) && result.amount) {
        console.log('[PaymentStatus] ✅ Payment confirmed PAID! Triggering Zoho sync...');
        doc.paymentStatus = 'paid';
        doc.paymentMethod = 'online';
        doc.paymentDate = new Date().toISOString().split('T')[0];
        doc.transactionId = result.paymentId || (doc as any).onlinePaymentLinkId;
        await doc.save();

        try {
          await this.convertQuotationToInvoiceAfterPaid({ quotationDoc: doc });
          console.log('[PaymentStatus] ✅ Invoice doc created in MongoDB');
        } catch (e: any) {
          console.error('[PaymentStatus] ❌ convertQuotationToInvoiceAfterPaid FAILED:', e.message);
        }

        try {
          await this.salesOrdersService.createOrUpdatePaidOrderFromQuotation({
            quotation: doc,
            paymentId: doc.transactionId,
            amount: Number(result.amount),
          });
          console.log('[PaymentStatus] ✅ createOrUpdatePaidOrderFromQuotation DONE');
        } catch (syncErr: any) {
          console.error('[PaymentStatus] ❌ createOrUpdatePaidOrderFromQuotation FAILED:', syncErr.message);
          console.error('[PaymentStatus] Stack:', syncErr.stack);
        }
      } else if (result && this.isFailedPaymentStatus(result.status)) {
        console.log('[PaymentStatus] ❌ Payment FAILED on Zoho side');
        doc.paymentStatus = 'failed';
        doc.paymentMethod = 'online';
        await doc.save();
      } else {
        console.log('[PaymentStatus] ⏳ Payment still pending. Zoho status:', result?.status ?? 'null');
      }
    }

    if (doc.type === 'quotation' && doc.paymentStatus === 'paid' && !doc.isSyncedToZoho) {
      await this.convertQuotationToInvoiceAfterPaid({ quotationDoc: doc });
      await this.salesOrdersService.createOrUpdatePaidOrderFromQuotation({
        quotation: doc,
        paymentId: doc.transactionId,
        amount: Number(doc.grandTotal || 0),
      });
    }

    const latestDoc: any =
      (await this.salesDocumentModel.findById((doc as any)._id).lean()) || doc;

    return {
      paymentStatus: latestDoc.paymentStatus || 'unpaid',
      paymentMethod: latestDoc.paymentMethod || '',
      paymentDate: latestDoc.paymentDate,
      transactionId: latestDoc.transactionId,
      onlinePaymentSessionId: latestDoc.onlinePaymentSessionId,
      onlinePaymentLinkId: latestDoc.onlinePaymentLinkId,
      isSyncedToZoho: latestDoc.isSyncedToZoho || false,
      zohoSalesOrderId: latestDoc.zohoSalesOrderId,
      zohoInvoiceId: latestDoc.zohoInvoiceId,
      zohoInvoiceUrl: latestDoc.zohoInvoiceUrl,
      zohoSyncError: latestDoc.zohoSyncError,
    };
  }

  private extractPaymentLink(source: any) {
    const direct =
      source?.payment_link ||
      source?.paymentLink ||
      source?.data?.payment_link ||
      source?.data?.paymentLink;

    if (direct) return direct;

    const links = source?.payment_links || source?.paymentLinks || source?.data?.payment_links;
    if (Array.isArray(links)) return links[0] || null;
    return links || null;
  }

  /**
   * Bridge for PaymentsController: handles direct salesperson-created orders
   * (not quotation/payment-link flow) when the Zoho webhook fires to /payments/webhook.
   * Delegates to the salesAuth OrdersService which looks in the 'salespersonOrders' collection.
   */
  async handleDirectSalesOrderPayment(
    orderId: string,
    paymentId: string,
    amount: number,
  ): Promise<void> {
    console.log('[SalesPayment] Delegating to salesAuth OrdersService for orderId:', orderId);
    await this.salesOrdersService.handlePaymentSuccess(orderId, paymentId, amount);
  }

  private isPaidPaymentStatus(status: any) {
    return ['succeeded', 'success', 'paid', 'completed', 'captured'].includes(
      String(status || '').toLowerCase(),
    );
  }

  private isFailedPaymentStatus(status: any) {
    return ['failed', 'failure', 'cancelled', 'canceled', 'expired'].includes(
      String(status || '').toLowerCase(),
    );
  }
}
