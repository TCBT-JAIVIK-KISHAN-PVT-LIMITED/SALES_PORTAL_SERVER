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

@Injectable()
export class SalesDocumentPaymentsService {
  constructor(
    @InjectModel(SalesDocument.name)
    private readonly salesDocumentModel: Model<SalesDocument>,
    private readonly zohoPaymentGateway: ZohoPaymentGatewayService,
    private readonly configService: ConfigService,
  ) {}

  private verifySignature(rawBody: Buffer, signature: string, secret: string) {
    if (!signature) return false;
    const expectedHash = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

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
    const referenceNumber = payment?.reference_number;

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

      // Convert quotation->invoice ONLY after payment success.
      if (doc.type === 'quotation') {
        await this.convertQuotationToInvoiceAfterPaid({
          quotationDoc: doc,
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
      })
      .lean();

    if (!doc) throw new BadRequestException('Sales document not found');
    return {
      paymentStatus: doc.paymentStatus || 'unpaid',
      paymentMethod: doc.paymentMethod || '',
      paymentDate: doc.paymentDate,
      transactionId: doc.transactionId,
      onlinePaymentSessionId: (doc as any).onlinePaymentSessionId,
    };
  }
}
