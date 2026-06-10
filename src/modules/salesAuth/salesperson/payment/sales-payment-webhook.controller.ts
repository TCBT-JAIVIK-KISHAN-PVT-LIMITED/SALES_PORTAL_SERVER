import { Controller, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { SalesDocumentPaymentsService } from './sales-document-payments.service';

@Controller('payments')
export class SalesPaymentWebhookController {
  constructor(private readonly paymentsService: SalesDocumentPaymentsService) {}

  @Post('webhook-sales-doc')
  async handleWebhook(@Req() req: Request) {
    console.log('\n========== [SalesDocWebhook] HIT /payments/webhook-sales-doc ==========');
    console.log('[SalesDocWebhook] Headers:', JSON.stringify(req.headers, null, 2));
    console.log('[SalesDocWebhook] Body type:', typeof req.body, '| is Buffer:', Buffer.isBuffer(req.body));
    return this.paymentsService.handleZohoWebhook(req);
  }
}
