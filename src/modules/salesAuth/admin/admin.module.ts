import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { ZohoModule } from '../../../zoho/zoho.module';
import { SalesAdminController } from './admin.controller';
import { SalesAdminGuard } from '../guards/sales-admin.guard';
import { SalesAdmin, SalesAdminSchema } from '../models/sales-admin.schema';
import {
  Salesperson,
  SalespersonSchema,
} from '../models/salesperson.schema';
import { SalesDocument, SalesDocumentSchema } from '../models/sales-document.schema';
import { SalesAuthService } from '../salesAuth.service';

@Module({
  imports: [
    ConfigModule,
    ZohoModule,
    MongooseModule.forFeature([
      { name: SalesAdmin.name, schema: SalesAdminSchema },
      { name: Salesperson.name, schema: SalespersonSchema },
      { name: SalesDocument.name, schema: SalesDocumentSchema },
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
  controllers: [SalesAdminController],
  providers: [SalesAuthService, SalesAdminGuard],
  exports: [SalesAuthService, SalesAdminGuard],
})
export class SalesAdminModule {}
