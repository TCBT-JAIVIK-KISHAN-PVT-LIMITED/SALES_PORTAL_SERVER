import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { SalesAdmin, SalesAdminSchema } from './models/sales-admin.schema';
import { Salesperson, SalespersonSchema } from './models/salesperson.schema';
import { SalesDocument, SalesDocumentSchema } from './models/sales-document.schema';
import { SalesSubAdmin, SalesSubAdminSchema } from './models/sales-subadmin.schema';
import { SalesAuthService } from './salesAuth.service';
import { SalesAdminModule } from './admin/admin.module';
import { SalesModule } from './salesperson/sales.module';
import { OrdersModule as SalesOrdersModule } from './salesOrders/orders.module';
import { SubAdminModule } from './subadmin/subadmin.module';
import { ZohoModule } from '../../zoho/zoho.module';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: SalesAdmin.name, schema: SalesAdminSchema },
      { name: Salesperson.name, schema: SalespersonSchema },
      { name: SalesDocument.name, schema: SalesDocumentSchema },
      { name: SalesSubAdmin.name, schema: SalesSubAdminSchema },
    ]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: {
          expiresIn: (cfg.get<string>('SALES_ACCESS_TOKEN_TTL') ?? '1d') as any,
        },
      }),
    }),
    SalesAdminModule,
    SalesModule,
    SalesOrdersModule,
    SubAdminModule,
    ZohoModule,
  ],
  providers: [SalesAuthService],
  exports: [SalesAuthService, SalesAdminModule, SalesModule, SalesOrdersModule, SubAdminModule],
})
export class SalesAuthModule {}
