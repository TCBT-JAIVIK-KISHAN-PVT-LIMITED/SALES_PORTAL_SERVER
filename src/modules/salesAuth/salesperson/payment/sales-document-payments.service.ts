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

  private verifySignature(rawBody: Buffer, signature: string, secret: string) {
    if (!signature) return false;
    const expectedHash = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    if (Buffer.byteLength(expectedHash) !== Buffer.byteLength(signature)) {
      return false;
    }

    return crypto.timingSafeEqual(
      Buffer.from(expectedHash),
      Buffer.from(signature),
    );
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

    // Create Zoho payment session using the existing gateway.
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

    // Zoho gateway may return either:
    // 1) payment session object that contains payment_url, OR
    // 2) wrapper containing payment_url.
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
    const { quotationId, farmerName, farmerPhone, amount, description } =
      params;

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

    const paymentLinks =
      session?.payment_links ||
      session?.payment_links?.[0] ||
      session?.payment_link ||
      session?.data?.payment_link ||
      session?.data?.payment_links?.[0];
    const paymentUrl =
      paymentLinks?.url || paymentLinks?.payment_url || paymentLinks?.paymentLink ||
      session?.url || session?.link;

    if (!paymentUrl) {
      console.error('Zoho response missing payment URL', JSON.stringify(session));
      throw new BadRequestException('Failed to generate payment link');
    }

    const expiresAt = paymentLinks?.expires_at || new Date(Date.now() + 72 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];
    const expiresAtFormatted = new Date(expiresAt).toLocaleString('en-US', {
      month: 'short',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });

    await this.salesDocumentModel.updateOne(
      { _id: doc._id },
      {
        $set: {
          onlinePaymentUrl: paymentUrl,
          onlinePaymentExpiresAt: expiresAt,
          onlinePaymentSessionId:
            session?.payments_session_id || session?.id || null,
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
    const signature = (req.headers['x-zoho-webhook-token'] as string) || '';
    const secret = this.configService.getOrThrow<string>(
      'ZOHO_PAYMENTS_SIGNING_KEY',
    );

    const anyReq = req as any;
    const rawBody: Buffer | undefined = anyReq.rawBody || anyReq.body;

    if (!rawBody || !(rawBody instanceof Buffer)) {
      throw new UnauthorizedException('Missing raw body');
    }

    if (!this.verifySignature(rawBody, signature, secret)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const payload = JSON.parse(rawBody.toString());
    const eventType = payload.event_type;
    const payment = payload.event_object?.payment;
    const paymentId = payment?.payment_id;
    const amount = payment?.amount;
    const referenceNumber =
      payment?.reference_number ||
      payment?.reference_id ||
      payload.event_object?.payment_link?.reference_id;

    if (!referenceNumber) return { received: true };

    const doc = await this.salesDocumentModel.findOne({
      documentNumber: referenceNumber,
    });
    if (!doc) return { received: true };

    if (eventType === 'payment.succeeded') {
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

      doc.paymentStatus = 'paid';
      doc.paymentMethod = 'online';
      doc.paymentDate = new Date().toISOString().split('T')[0];
      doc.transactionId = paymentId;

      // Convert quotation->invoice ONLY after payment success.
      if (doc.type === 'quotation') {
        await this.convertQuotationToInvoiceAfterPaid({
          quotationDoc: doc,
        });
        await this.salesOrdersService.createOrUpdatePaidOrderFromQuotation({
          quotation: doc,
          paymentId,
          amount: Number(amount || doc.grandTotal || 0),
        });
      }
    }

    if (eventType === 'payment.failed') {
      await this.salesDocumentModel.updateOne(
        { _id: doc._id },
        { $set: { paymentStatus: 'failed', paymentMethod: 'online' } },
      );
    }

    return { received: true };
  }

  private async convertQuotationToInvoiceAfterPaid(params: {
    quotationDoc: SalesDocument;
  }) {
    const quotation = params.quotationDoc;

    const invoiceDocumentNumber = quotation.documentNumber.replace(
      'QT-',
      'INV-',
    );

    // Create invoice only if it doesn't already exist.
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

  async getPaymentStatus(params: {
    salespersonId: string;
    documentNumber: string;
  }) {
    const doc = await this.salesDocumentModel
      .findOne({
        salesperson_id: params.salespersonId,
        documentNumber: params.documentNumber,
      });

    if (!doc) throw new BadRequestException('Sales document not found');

    if (
      doc.type === 'quotation' &&
      doc.paymentStatus !== 'paid' &&
      doc.onlinePaymentSessionId
    ) {
      const result = await this.zohoPaymentGateway.verifyPaymentSessionStatus(
        doc.onlinePaymentSessionId,
      );

      if (result.status === 'succeeded' && result.paymentId && result.amount) {
        doc.paymentStatus = 'paid';
        doc.paymentMethod = 'online';
        doc.paymentDate = new Date().toISOString().split('T')[0];
        doc.transactionId = result.paymentId;
        await doc.save();

        await this.convertQuotationToInvoiceAfterPaid({ quotationDoc: doc });
        await this.salesOrdersService.createOrUpdatePaidOrderFromQuotation({
          quotation: doc,
          paymentId: result.paymentId,
          amount: Number(result.amount),
        });
      } else if (result.status === 'failed') {
        doc.paymentStatus = 'failed';
        doc.paymentMethod = 'online';
        await doc.save();
      }
    }

    return {
      paymentStatus: doc.paymentStatus || 'unpaid',
      paymentMethod: doc.paymentMethod || '',
      paymentDate: doc.paymentDate,
      transactionId: doc.transactionId,
      onlinePaymentSessionId: (doc as any).onlinePaymentSessionId,
    };
  }
}
