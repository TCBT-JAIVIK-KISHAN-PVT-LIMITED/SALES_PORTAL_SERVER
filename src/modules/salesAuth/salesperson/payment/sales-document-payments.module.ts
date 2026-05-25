import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  SalesDocument,
  SalesDocumentSchema,
} from '../../../salesAuth/models/sales-document.schema';
import { PaymentsModule } from '../../../../integrations/payments/payments.module';
import { SalesDocumentPaymentsController } from '../payment/sales-document-payments.controller';
import { SalesPaymentLinksController } from './sales-payment-links.controller';
import { SalesPaymentWebhookController } from './sales-payment-webhook.controller';
import { SalesDocumentPaymentsService } from '../payment/sales-document-payments.service';
import { SalespersonGuard } from '../../guards/salesperson.guard';
import { OrdersModule as SalesOrdersModule } from '../../salesOrders/orders.module';

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
    PaymentsModule,
    SalesOrdersModule,
  ],
  controllers: [SalesDocumentPaymentsController, SalesPaymentLinksController, SalesPaymentWebhookController],
  providers: [SalesDocumentPaymentsService, SalespersonGuard],
  exports: [SalesDocumentPaymentsService],
})
export class SalesDocumentPaymentsModule {}
