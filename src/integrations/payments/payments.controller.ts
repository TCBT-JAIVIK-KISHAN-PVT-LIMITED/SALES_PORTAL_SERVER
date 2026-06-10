import {
  Controller,
  Post,
  Req,
  Body,
  UnauthorizedException,
  Get,
  Param,
} from '@nestjs/common';
import { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { OrdersService } from '../../modules/orders/orders.service';
import { ZohoPaymentLinksService } from './zoho-payment-links.service';
import { CreatePaymentLinkDto } from './dto/create-payment-link.dto';
import { SalesDocumentPaymentsService } from '../../modules/salesAuth/salesperson/payment/sales-document-payments.service';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly configService: ConfigService,
    private readonly zohoPaymentLinksService: ZohoPaymentLinksService,
    private readonly salesDocPaymentsService: SalesDocumentPaymentsService,
  ) { }

  @Post('webhook')
  async handleWebhook(@Req() req: RawBodyRequest) {
    console.log('\n========== [PaymentsWebhook] INCOMING REQUEST ==========');
    console.log('[PaymentsWebhook] Headers:', JSON.stringify(req.headers, null, 2));

    // Zoho sends signature in 'x-zoho-webhook-signature' as 't=<ts>,v=<hex>'
    const sigHeader = (req.headers['x-zoho-webhook-signature'] as string) || '';
    console.log('[PaymentsWebhook] x-zoho-webhook-signature header:', sigHeader || '❌ MISSING');

    const secret = this.configService.getOrThrow<string>('ZOHO_PAYMENTS_SIGNING_KEY');
    console.log('[PaymentsWebhook] Signing key (first 10 chars):', secret?.slice(0, 10) + '...');

    const rawBody = req.body as Buffer;
    console.log('[PaymentsWebhook] rawBody present?', !!rawBody);
    console.log('[PaymentsWebhook] rawBody is Buffer?', Buffer.isBuffer(rawBody));
    console.log('[PaymentsWebhook] rawBody length:', rawBody?.length ?? 0);

    if (!rawBody) {
      console.error('[PaymentsWebhook] ❌ Missing raw body — rejecting');
      throw new UnauthorizedException('Missing raw body');
    }

    const rawBodyStr = rawBody.toString();
    console.log('[PaymentsWebhook] Raw body string:', rawBodyStr);

    // Parse t=<timestamp>,v=<hex> from the header
    const timestamp = sigHeader.match(/t=(\d+)/)?.[1] ?? '';
    const receivedV = sigHeader.match(/v=([a-f0-9]+)/i)?.[1] ?? '';
    console.log('[PaymentsWebhook] Parsed timestamp:', timestamp || '❌ MISSING');
    console.log('[PaymentsWebhook] Parsed v (hex):', receivedV || '❌ MISSING');

    const signatureValid = this.verifySignature(rawBody, timestamp, receivedV, secret);
    console.log('[PaymentsWebhook] Signature valid?', signatureValid);

    if (!signatureValid) {
      console.error('[PaymentsWebhook] ❌ Invalid signature — rejecting');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // ✅ Parse JSON manually
    let body: any;
    try {
      body = JSON.parse(rawBodyStr);
      console.log('[PaymentsWebhook] Parsed body:', JSON.stringify(body, null, 2));
    } catch (parseErr: any) {
      console.error('[PaymentsWebhook] ❌ JSON parse failed:', parseErr.message);
      return { ok: false, error: 'json_parse_failed' };
    }

    const eventType = body.event_type;
    const eventObject = body.event_object;
    const payment = eventObject?.payment;
    const paymentLink = eventObject?.payment_link;

    console.log('[PaymentsWebhook] event_type:', eventType);
    console.log('[PaymentsWebhook] event_object keys:', Object.keys(eventObject || {}));
    console.log('[PaymentsWebhook] payment object:', JSON.stringify(payment, null, 2));
    console.log('[PaymentsWebhook] payment_link object:', JSON.stringify(paymentLink, null, 2));

    const paymentId = payment?.payment_id;
    const amount = payment?.amount;
    const orderId = payment?.reference_number || payment?.reference_id;

    // 🔥 Payment Link events: Zoho puts QT number in description, not reference_number
    const descriptionRef =
      payment?.description?.match(/(QT-[\w-]+)/)?.[1] ||
      paymentLink?.description?.match(/(QT-[\w-]+)/)?.[1] ||
      paymentLink?.reference_id ||
      payment?.payment_link_id; // fallback: use payment_link_id to look up by onlinePaymentLinkId

    const referenceId = descriptionRef || paymentLink?.reference_id;

    console.log('[PaymentsWebhook] Extracted fields:', {
      paymentId: paymentId || '❌ MISSING',
      amount: amount ?? '❌ MISSING',
      orderId: orderId || '❌ MISSING',
      referenceId: referenceId || '❌ MISSING',
      descriptionRef: descriptionRef || '❌ MISSING',
      paymentLinkId: payment?.payment_link_id || '❌ MISSING',
      description: payment?.description || '❌ MISSING',
    });

    if (!orderId && !referenceId) {
      console.warn('[PaymentsWebhook] ⚠️ No orderId or referenceId found — ignoring event');
      return { ok: false };
    }

    // 🔥 Payment Link events: no orderId but has referenceId.
    if (!orderId && referenceId) {
      console.log('[PaymentsWebhook] → Payment Link event detected (referenceId:', referenceId, ') — forwarding to SalesDocPaymentsService');
      try {
        return await this.salesDocPaymentsService.handleZohoWebhook(req);
      } catch (err: any) {
        console.error('[PaymentsWebhook] ❌ SalesDoc webhook handler error:', err?.message || err);
        return { received: true, error: 'sales_doc_handler_failed' };
      }
    }

    console.log('[PaymentsWebhook] → Has orderId:', orderId, '— processing payment event:', eventType);

    if (eventType === 'payment.succeeded') {
      console.log('[PaymentsWebhook] Step 1: Trying regular OrdersService for orderId:', orderId);
      try {
        await this.ordersService.handlePaymentSuccess(orderId, paymentId, amount);
        console.log('[PaymentsWebhook] ✅ Regular OrdersService handled successfully');
      } catch (err: any) {
        console.warn('[PaymentsWebhook] Regular OrdersService threw:', err?.message);
        if (err?.message === 'Order not found') {
          console.log('[PaymentsWebhook] Step 2: Falling back to salesAuth OrdersService for orderId:', orderId);
          try {
            await this.salesDocPaymentsService.handleDirectSalesOrderPayment(
              orderId,
              paymentId,
              Number(amount),
            );
            console.log('[PaymentsWebhook] ✅ SalesAuth OrdersService handled successfully');
          } catch (salesErr: any) {
            console.error('[PaymentsWebhook] ❌ SalesAuth OrdersService ALSO failed:', salesErr?.message);
            console.error('[PaymentsWebhook] Stack:', salesErr?.stack);
          }
        } else {
          console.error('[PaymentsWebhook] ❌ Non-recoverable error from regular OrdersService:', err?.message);
          throw err;
        }
      }
    } else if (eventType === 'payment.failed') {
      console.log('[PaymentsWebhook] Processing payment.failed for orderId:', orderId);
      try {
        await this.ordersService.handlePaymentFailure(orderId);
        console.log('[PaymentsWebhook] ✅ handlePaymentFailure done');
      } catch (err: any) {
        if (err?.message !== 'Order not found') throw err;
        console.warn('[PaymentsWebhook] ⚠️ Failure for salesperson order — ignored');
      }
    } else {
      console.log('[PaymentsWebhook] ℹ️ Unhandled event type:', eventType, '— ignoring');
    }

    console.log('[PaymentsWebhook] ✅ Done — returning { received: true }');
    console.log('========================================================\n');
    return { received: true };
  }

  private verifySignature(
    rawBody: Buffer,
    timestamp: string,
    receivedV: string,
    secret: string,
  ): boolean {
    if (!receivedV) {
      console.warn('[verifySignature] ⚠️ No v= value in signature header — skipping (ping/test request)');
      return false;
    }

    // ✅ Attempt 1 (CONFIRMED CORRECT): HMAC-SHA256(secret, timestamp + "." + rawBody) in hex
    if (timestamp) {
      const message = Buffer.concat([Buffer.from(timestamp + '.'), rawBody]);
      const computed = crypto.createHmac('sha256', secret).update(message).digest('hex');
      console.log('[verifySignature] Attempt 1 (timestamp.rawBody, hex):', computed);
      console.log('[verifySignature] Received v:', receivedV);
      if (computed.toLowerCase() === receivedV.toLowerCase()) {
        console.log('[verifySignature] ✅ Matched!');
        return true;
      }
    }

    // Fallback: HMAC-SHA256(secret, rawBody) in hex
    const fallback = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    console.log('[verifySignature] Fallback (rawBody only, hex):', fallback);
    if (fallback.toLowerCase() === receivedV.toLowerCase()) {
      console.log('[verifySignature] ✅ Matched on fallback (rawBody only)');
      return true;
    }

    console.error('[verifySignature] ❌ No match found');
    return false;
  }

  @Get('verify/:orderId')
  async verifyPayment(@Param('orderId') orderId: string) {
    return this.ordersService.verifyAndConfirmOrder(orderId);
  }

  @Post('payment-link')
  async createPaymentLink(
    @Body() body: CreatePaymentLinkDto,
  ) {
    return this.zohoPaymentLinksService.createPaymentLink(
      body,
    );
  }
}