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

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly configService: ConfigService,
  ) { }

  @Post('webhook')
  async handleWebhook(@Req() req: RawBodyRequest) {
    const signature = req.headers['x-zoho-webhook-token'] as string;

    const secret = this.configService.getOrThrow<string>(
      'ZOHO_PAYMENTS_SIGNING_KEY',
    );

    const rawBody = req.body as Buffer;

    if (!rawBody) {
      throw new UnauthorizedException('Missing raw body');
    }

    if (!this.verifySignature(rawBody, signature, secret)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // ✅ Parse JSON manually
    const body = JSON.parse(rawBody.toString());

    const eventType = body.event_type;
    const payment = body.event_object?.payment;

    const paymentId = payment?.payment_id;
    const amount = payment?.amount;
    const orderId = payment?.reference_number;

    if (!orderId) return { ok: false };

    if (eventType === 'payment.succeeded') {
      await this.ordersService.handlePaymentSuccess(
        orderId,
        paymentId,
        amount,
      );
    } else if (eventType === 'payment.failed') {
      await this.ordersService.handlePaymentFailure(orderId);
    }

    return { received: true };
  }

  private verifySignature(
    rawBody: Buffer,
    signature: string,
    secret: string,
  ): boolean {
    if (!signature) return false;

    const expectedHash = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64'); // ✅ Zoho sends base64, not hex

    console.log('Expected (base64):', expectedHash);
    console.log('Received:', signature);

    return crypto.timingSafeEqual(
      Buffer.from(expectedHash),
      Buffer.from(signature),
    );
  }

  @Get('verify/:orderId')
  async verifyPayment(@Param('orderId') orderId: string) {
    return this.ordersService.verifyAndConfirmOrder(orderId);
  }
}