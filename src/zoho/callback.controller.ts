import {
  Controller,
  Get,
  Query,
  Param,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ZohoAuthService } from './core/zoho-auth.service';
import { ZohoPaymentsService } from './payments/payments.service';
import type { ZohoService } from './config/zoho-scope.config';

@Controller('callback')
export class CallbackController {
  constructor(
    private readonly zohoAuthService: ZohoAuthService,
    private readonly zohoPaymentsService: ZohoPaymentsService,
  ) { }

  @Get('auth-url/:service')
  getAuthUrl(@Param('service') service: ZohoService) {
    const allowedServices: ZohoService[] = ['crm', 'inventory', 'payments', 'books'];
    if (!allowedServices.includes(service)) {
      throw new BadRequestException(`Invalid service: ${service}`);
    }
    return {
      url: this.zohoAuthService.getAuthUrl(service),
    };
  }

  @Get()
  async handleCallback(
    @Query('code') code?: string,
    @Query('state') service?: ZohoService
  ) {
    console.log(`[DEBUG] handleCallback called with code: "${code}", state: "${service}"`);
    if (!code) {
      throw new BadRequestException('Authorization code missing');
    }

    if (!service) {
      throw new BadRequestException('Service (state) missing');
    }

    const allowedServices: ZohoService[] = ['crm', 'inventory', 'payments', 'books'];

    if (!allowedServices.includes(service)) {
      throw new BadRequestException(`Invalid service: ${service}`);
    }

    try {

      if (service === 'payments') {
        console.log('[DEBUG] Exchanging token for payments service');
        const data = await this.zohoPaymentsService.exchangeCodeForToken(code);

        return {
          message: 'Zoho Payments token saved successfully',
          data,
        };
      }

      console.log(`[DEBUG] Calling zohoAuthService.exchangeCodeForToken for service: ${service}`);
      const data = await this.zohoAuthService.exchangeCodeForToken(
        code,
        service,
      );

      console.log(`[DEBUG] Exchange succeeded for service: ${service}`);
      return {
        success: true,
        message: `Zoho token saved successfully`,
        service,
        expires_in: data.expires_in,
        scope: data.scope,
      };
    } catch (error: any) {
      console.error('[DEBUG] Zoho Callback Error:', error);

      throw new InternalServerErrorException('Failed to exchange Zoho token');
    }
  }
}
