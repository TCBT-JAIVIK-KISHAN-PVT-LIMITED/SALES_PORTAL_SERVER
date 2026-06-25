import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { OrdersService } from './orders.service';
import { Order, OrderSchema } from './schemas/order.schema';
import { SalesDocument, SalesDocumentSchema } from '../models/sales-document.schema';
import { Salesperson, SalespersonSchema } from '../models/salesperson.schema';
import { PaymentsModule } from '../../../integrations/payments/payments.module';
import { OrdersController } from './orders.controller';
import { ZohoModule } from '../../../zoho/zoho.module';

import { SmsService } from './sms.service';
import { CommunicationService } from './communication.service';
import { SalespersonGuard } from '../guards/salesperson.guard';

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
      { name: Order.name, schema: OrderSchema },
      { name: SalesDocument.name, schema: SalesDocumentSchema },
      { name: Salesperson.name, schema: SalespersonSchema },
    ]),
    ZohoModule,
    PaymentsModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService, SmsService, CommunicationService, SalespersonGuard],
  exports: [OrdersService],
})
export class OrdersModule { }
