// zoho/zoho.module.ts

import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ZohoToken, ZohoTokenSchema } from './schemas/zoho-token.schema';

import { ZohoAuthService } from './core/zoho-auth.service';
import { ZohoHttpService } from './core/zoho-http.service';
import { CrmService } from './crm/crm.service';
import { ZohoInventoryService } from './inventory/inventory.service';
import { ZohoBooksService } from './books/books.service';


@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ZohoToken.name, schema: ZohoTokenSchema },
    ]),

  ],
  providers: [
    ZohoAuthService,
    ZohoHttpService,
    CrmService,
    ZohoInventoryService,
    ZohoBooksService,
  ],
  exports: [CrmService, ZohoInventoryService, ZohoAuthService, ZohoBooksService],
})
export class ZohoModule {}

