import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { SubAdminController } from './subadmin.controller';
import { SalesAuthService } from '../salesAuth.service';
import { SubAdminGuard } from '../guards/subadmin.guard';
import { SalesAdmin, SalesAdminSchema } from '../models/sales-admin.schema';
import { Salesperson, SalespersonSchema } from '../models/salesperson.schema';
import { SalesDocument, SalesDocumentSchema } from '../models/sales-document.schema';
import { SalesSubAdmin, SalesSubAdminSchema } from '../models/sales-subadmin.schema';
import { Order, OrderSchema } from '../salesOrders/schemas/order.schema';
import { ZohoModule } from '../../../zoho/zoho.module';
import { RolesGuard } from '../guards/roles.guard';
import { HierarchyGuard } from '../guards/hierarchy.guard';

@Module({
  imports: [
    ConfigModule,
    ZohoModule,
    MongooseModule.forFeature([
      { name: SalesAdmin.name, schema: SalesAdminSchema },
      { name: Salesperson.name, schema: SalespersonSchema },
      { name: SalesDocument.name, schema: SalesDocumentSchema },
      { name: SalesSubAdmin.name, schema: SalesSubAdminSchema },
      { name: Order.name, schema: OrderSchema },
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
  ],
  controllers: [SubAdminController],
  providers: [SalesAuthService, SubAdminGuard, RolesGuard, HierarchyGuard],
  exports: [SalesAuthService, SubAdminGuard, RolesGuard, HierarchyGuard],
})
export class SubAdminModule {}
