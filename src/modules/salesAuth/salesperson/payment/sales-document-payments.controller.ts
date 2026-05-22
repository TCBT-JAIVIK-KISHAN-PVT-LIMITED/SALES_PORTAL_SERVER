import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SalespersonGuard } from '../../guards/salesperson.guard';
import { CurrentSalesUser } from '../../decorators/current-sales-user.decorator';
import { SalesDocumentPaymentsService } from '../payment/sales-document-payments.service';
import { IsString } from 'class-validator';

class CreateOnlinePaymentDto {
  @IsString()
  documentNumber!: string;

  @IsString()
  paymentMethod!: 'online';
}

@Controller('sales-auth/salesperson')
export class SalesDocumentPaymentsController {
  constructor(private readonly paymentsService: SalesDocumentPaymentsService) {}

  @UseGuards(SalespersonGuard)
  @Post('documents/:documentNumber/pay-online')
  async payOnline(
    @Param('documentNumber') documentNumber: string,
    @CurrentSalesUser() salesperson: { login_id: string },
  ) {
    return this.paymentsService.createOnlinePaymentForSalesDocument({
      salespersonId: salesperson.login_id,
      documentNumber,
    });
  }

  // Called by Zoho for salesperson payment completion.
  // NOTE: This is separate from the existing `/payments/webhook` to not break orders flow.
  @Post('payments/webhook-sales-doc')
  async webhookSalesDoc(@Req() req: Request) {
    return this.paymentsService.handleZohoWebhook(req);
  }

  @UseGuards(SalespersonGuard)
  @Get('documents/:documentNumber/payment-status')
  async getPaymentStatus(
    @Param('documentNumber') documentNumber: string,
    @CurrentSalesUser() salesperson: { login_id: string },
  ) {
    return this.paymentsService.getPaymentStatus({
      salespersonId: salesperson.login_id,
      documentNumber,
    });
  }
}
