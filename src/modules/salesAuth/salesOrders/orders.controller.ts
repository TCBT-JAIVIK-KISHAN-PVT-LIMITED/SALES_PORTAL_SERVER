import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Query,
  Req,
  UseGuards,
  UnauthorizedException,
  Body,
  Headers,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import type { Request } from 'express';
import { OrdersService } from './orders.service';
import { SendQuotationDto } from './dto/send-quotation.dto';
import { SalespersonGuard } from '../guards/salesperson.guard';
import { CurrentSalesUser } from '../decorators/current-sales-user.decorator';

@Controller('sales-auth/salesperson/sales-orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly configService: ConfigService,
  ) { }




  @Post('send-quotation')
  async sendQuotation(@Body() body: SendQuotationDto) {
    return this.ordersService.sendQuotation(body);
  }

  @UseGuards(SalespersonGuard)
  @Get()
  async getOrders(
    @CurrentSalesUser() salesperson: { login_id: string },
    @Query('page') page = 1,
    @Query('limit') limit = 10,
  ) {
    const salesId = salesperson.login_id;
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(50, Number(limit));
    return this.ordersService.getOrders(salesId, pageNum, limitNum);
  }

  @UseGuards(SalespersonGuard)
  @Get(':orderId')
  async getOrder(
    @CurrentSalesUser() salesperson: { login_id: string },
    @Param('orderId') orderId: string,
  ) {
    const salesId = salesperson.login_id;
    return this.ordersService.getOrderById(salesId, orderId);
  }

  @UseGuards(SalespersonGuard)
  @Patch(':orderId/cancel')
  async cancelOrder(
    @CurrentSalesUser() salesperson: { login_id: string },
    @Param('orderId') orderId: string,
  ) {
    const salesId = salesperson.login_id;

    if (!salesId) {
      throw new Error('Unauthorized');
    }

    return this.ordersService.cancelOrder(salesId, orderId);
  }

  @Get('payments/verify/:orderId')
  async verifyPayment(@Param('orderId') orderId: string) {
    console.log('Verifying payment for order:', orderId);  
    return this.ordersService.verifyAndConfirmOrder(orderId);
  }

  @Post('payments/webhook')
  async handleWebhook(
    @Req() req: Request,
    @Headers('x-zoho-webhook-token') signature: string,
  ) {
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

    const body = JSON.parse(rawBody.toString());
    const eventType = body.event_type;
    const payment = body.event_object?.payment;
    const paymentId = payment?.payment_id;
    const amount = payment?.amount;
    const orderId = payment?.reference_number;

    if (!orderId) return { ok: false };

    if (eventType === 'payment.succeeded') {
      await this.ordersService.handlePaymentSuccess(orderId, paymentId, amount);
      console.log(`Payment succeeded for order ${orderId}, payment ID: ${paymentId}, amount: ${amount}`);
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
      .digest('base64');

    if (Buffer.byteLength(expectedHash) !== Buffer.byteLength(signature)) {
      return false;
    }

    return crypto.timingSafeEqual(
      Buffer.from(expectedHash),
      Buffer.from(signature),
    );
  }
}
