import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  SalesDocument,
  SalesDocumentSchema,
} from '../../../salesAuth/models/sales-document.schema';
import { ZohoPaymentGatewayService } from '../../../../integrations/payments/zoho-payment-gateway.service';
import { ZohoPaymentsModule } from '../../../../zoho/payments/payments.module';
import { SalesDocumentPaymentsController } from '../payment/sales-document-payments.controller';
import { SalesDocumentPaymentsService } from '../payment/sales-document-payments.service';

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: {
          expiresIn: (cfg.get<string>('SALES_ACCESS_TOKEN_TTL') ?? '1d') as any,
        },
      }),
    }),
    MongooseModule.forFeature([
      { name: SalesDocument.name, schema: SalesDocumentSchema },
    ]),
    ZohoPaymentsModule,
  ],
  controllers: [SalesDocumentPaymentsController],
  providers: [SalesDocumentPaymentsService, ZohoPaymentGatewayService],
  exports: [SalesDocumentPaymentsService],
})
export class SalesDocumentPaymentsModule {}
