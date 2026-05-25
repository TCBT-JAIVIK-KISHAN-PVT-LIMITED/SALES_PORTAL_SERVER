import {
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { SalesAdmin } from './models/sales-admin.schema';
import { Salesperson } from './models/salesperson.schema';
import { SalesDocument } from './models/sales-document.schema';
import { SalesAdminLoginDto } from './dto/sales-admin-login.dto';
import { CreateSalespersonDto } from './dto/create-salesperson.dto';
import { SalespersonLoginDto } from './dto/salesperson-login.dto';

type SalesAuthRole = 'sales_admin' | 'salesperson';

@Injectable()
export class SalesAuthService implements OnModuleInit {
  private static adminSeedStarted = false;

  constructor(
    @InjectModel(SalesAdmin.name)
    private salesAdminModel: Model<SalesAdmin>,
    @InjectModel(Salesperson.name)
    private salespersonModel: Model<Salesperson>,
    @InjectModel(SalesDocument.name)
    private salesDocumentModel: Model<SalesDocument>,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async onModuleInit() {
    if (SalesAuthService.adminSeedStarted) return;
    SalesAuthService.adminSeedStarted = true;

    const adminId = this.configService.get<string>('SALES_ADMIN_ID')?.trim();
    const password = this.configService.get<string>('SALES_ADMIN_PASSWORD')?.trim();

    console.log('[DEBUG] Admin seed check:', {
      adminId: adminId,
      password_provided: !!password,
      password_length: password?.length,
    });

    if (!adminId || !password) {
      console.warn('[WARN] Skipping admin seed - missing credentials');
      return;
    }

    const existingAdmin = await this.salesAdminModel.findOne({
      singleton_key: 'SALES_ADMIN',
    });

    if (existingAdmin) {
      const passwordMatches = existingAdmin.password_hash
        ? await bcrypt.compare(password, existingAdmin.password_hash)
        : false;

      if (existingAdmin.admin_id === adminId && passwordMatches) {
        console.log('[DEBUG] Admin already exists with matching env credentials, skipping seed', {
          admin_id: existingAdmin.admin_id,
        });
        return;
      }

      console.log('[DEBUG] Admin exists, updating admin credentials from env', {
        old_admin_id: existingAdmin.admin_id,
        new_admin_id: adminId,
      });

      existingAdmin.admin_id = adminId;
      existingAdmin.password_hash = await bcrypt.hash(password, 10);
      existingAdmin.name = this.configService.get<string>('SALES_ADMIN_NAME') ?? existingAdmin.name;
      existingAdmin.email = this.configService.get<string>('SALES_ADMIN_EMAIL') ?? existingAdmin.email;
      existingAdmin.is_active = true;
      await existingAdmin.save();

      console.log('[DEBUG] Admin record updated from env', {
        admin_id: existingAdmin.admin_id,
        password_hash_length: existingAdmin.password_hash?.length,
      });
      return;
    }

    console.log('[DEBUG] Creating new admin record...');
    const password_hash = await bcrypt.hash(password, 10);

    const newAdmin = await this.salesAdminModel.create({
      singleton_key: 'SALES_ADMIN',
      admin_id: adminId,
      password_hash,
      name: this.configService.get<string>('SALES_ADMIN_NAME') ?? 'Sales Admin',
      email: this.configService.get<string>('SALES_ADMIN_EMAIL'),
      is_active: true,
    });

    console.log('[DEBUG] Admin record created:', {
      admin_id: newAdmin.admin_id,
      password_hash_length: newAdmin.password_hash?.length,
    });
  }

  async loginAdmin(dto: SalesAdminLoginDto) {
    const admin = await this.salesAdminModel.findOne({
      admin_id: dto.admin_id.trim(),
      singleton_key: 'SALES_ADMIN',
      is_active: true,
    });

    console.log('[DEBUG] Admin lookup result:', {
      found: !!admin,
      admin_id: admin?.admin_id,
      password_hash_exists: !!admin?.password_hash,
      password_hash_length: admin?.password_hash?.length,
    });

    if (!admin) throw new UnauthorizedException('Invalid admin credentials');

    if (!admin.password_hash) {
      console.error('[ERROR] Admin password_hash is null or empty!', {
        admin_id: admin.admin_id,
        password_hash: admin.password_hash,
      });
      throw new UnauthorizedException('Invalid admin credentials');
    }

    const passwordOk = await bcrypt.compare(dto.password, admin.password_hash);
    console.log('[DEBUG] Password comparison result:', {
      admin_id: admin.admin_id,
      passwordOk,
      inputPasswordLength: dto.password.length,
      hashLength: admin.password_hash.length,
    });

    if (!passwordOk) {
      throw new UnauthorizedException('Invalid admin credentials');
    }

    admin.last_login_at = new Date();
    await admin.save();

    const access_token = this.signToken(
      admin._id.toString(),
      'sales_admin',
      admin.admin_id,
    );

    return {
      access_token,
      admin: this.toAdminResponse(admin),
    };
  }

  async createSalesperson(
    dto: CreateSalespersonDto,
    admin: { sub: string; login_id: string },
  ) {
    const salespersonId = dto.salesperson_id.trim();
    const existing = await this.salespersonModel.exists({
      salesperson_id: salespersonId,
    });

    if (existing) {
      throw new ConflictException('Salesperson ID already exists');
    }

    const password_hash = await bcrypt.hash(dto.password, 10);

    const salesperson = await this.salespersonModel.create({
      salesperson_id: salespersonId,
      password_hash,
      name: dto.name.trim(),
      email: dto.email?.trim().toLowerCase(),
      mobile_number: dto.mobile_number?.trim(),
      created_by_admin_id: admin.sub,
    });

    return {
      message: 'Salesperson created successfully',
      salesperson: this.toSalespersonResponse(salesperson),
      assigned_credentials: {
        salesperson_id: salesperson.salesperson_id,
      },
    };
  }

  async loginSalesperson(dto: SalespersonLoginDto) {
    const salesperson = await this.salespersonModel.findOne({
      salesperson_id: dto.salesperson_id.trim(),
      is_active: true,
    });

    console.log('[DEBUG] Salesperson lookup result:', {
      found: !!salesperson,
      salesperson_id: salesperson?.salesperson_id,
      password_hash_exists: !!salesperson?.password_hash,
      password_hash_length: salesperson?.password_hash?.length,
    });

    if (!salesperson) {
      throw new UnauthorizedException('Invalid salesperson credentials');
    }

    if (!salesperson.password_hash) {
      console.error('[ERROR] Salesperson password_hash is null or empty!', {
        salesperson_id: salesperson.salesperson_id,
        password_hash: salesperson.password_hash,
      });
      throw new UnauthorizedException('Invalid salesperson credentials');
    }

    const passwordOk = await bcrypt.compare(
      dto.password,
      salesperson.password_hash,
    );

    console.log('[DEBUG] Password comparison result:', {
      salesperson_id: salesperson.salesperson_id,
      passwordOk,
      inputPasswordLength: dto.password.length,
      hashLength: salesperson.password_hash.length,
    });

    if (!passwordOk) {
      throw new UnauthorizedException('Invalid salesperson credentials');
    }

    salesperson.last_login_at = new Date();
    await salesperson.save();

    const access_token = this.signToken(
      salesperson._id.toString(),
      'salesperson',
      salesperson.salesperson_id,
    );

    return {
      access_token,
      salesperson: this.toSalespersonResponse(salesperson),
    };
  }

  async deleteSalesperson(salespersonId: string) {
    const trimmedId = salespersonId.trim();
    const deleted = await this.salespersonModel.findOneAndDelete({
      salesperson_id: trimmedId,
    });

    if (!deleted) {
      throw new NotFoundException('Salesperson not found');
    }

    const deletedDocuments = await this.salesDocumentModel.deleteMany({
      salesperson_id: deleted.salesperson_id,
    });

    return {
      message: 'Salesperson and related orders deleted successfully',
      salesperson_id: deleted.salesperson_id,
      deleted_orders: deletedDocuments.deletedCount || 0,
    };
  }

  private signToken(sub: string, role: SalesAuthRole, login_id: string) {
    return this.jwtService.sign({
      sub,
      role,
      login_id,
      auth_area: 'sales_portal',
    });
  }

  private toAdminResponse(admin: SalesAdmin) {
    return {
      id: admin._id.toString(),
      admin_id: admin.admin_id,
      name: admin.name,
      email: admin.email,
      is_active: admin.is_active,
      last_login_at: admin.last_login_at,
    };
  }

  private toSalespersonResponse(salesperson: Salesperson) {
    return {
      id: salesperson._id.toString(),
      salesperson_id: salesperson.salesperson_id,
      name: salesperson.name,
      email: salesperson.email,
      mobile_number: salesperson.mobile_number,
      is_active: salesperson.is_active,
      created_by_admin_id: salesperson.created_by_admin_id,
      last_login_at: salesperson.last_login_at,
    };
  }
}
