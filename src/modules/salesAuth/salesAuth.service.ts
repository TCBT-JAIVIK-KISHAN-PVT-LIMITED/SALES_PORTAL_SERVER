import {
  BadRequestException,
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
import { SalesSubAdmin } from './models/sales-subadmin.schema';
import { SalesAdminLoginDto } from './dto/sales-admin-login.dto';
import { CreateSalespersonDto } from './dto/create-salesperson.dto';
import { SalespersonLoginDto } from './dto/salesperson-login.dto';
import { CreateSubAdminDto } from './dto/create-subadmin.dto';
import { SubAdminLoginDto } from './dto/subadmin-login.dto';
import { ZohoBooksService } from '../../zoho/books/books.service';

type SalesAuthRole = 'sales_admin' | 'subadmin' | 'salesperson';

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
    @InjectModel(SalesSubAdmin.name)
    private salesSubAdminModel: Model<SalesSubAdmin>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private readonly zohoBooksService: ZohoBooksService,
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

    let zohoSalespersonId: string | undefined;
    try {
      const foundId = await this.zohoBooksService.findSalespersonId(
        dto.name.trim(),
        dto.email?.trim(),
      );

      if (foundId) {
        zohoSalespersonId = foundId;
        console.log('[SalesAuthService] Found existing salesperson in Zoho Books:', foundId);
      } else {
        const zSp = await this.zohoBooksService.createSalesperson(
          dto.name.trim(),
          dto.email?.trim(),
        );
        zohoSalespersonId = zSp?.salesperson_id;
        console.log('[SalesAuthService] Created new salesperson in Zoho Books:', zohoSalespersonId);
      }
    } catch (err: any) {
      console.error('[SalesAuthService] Failed to create/find salesperson in Zoho Books:', err.message);
      throw new ConflictException(`Zoho Books integration failed: ${err.message}`);
    }

    const password_hash = await bcrypt.hash(dto.password, 10);

    const salesperson = await this.salespersonModel.create({
      salesperson_id: salespersonId,
      password_hash,
      name: dto.name.trim(),
      email: dto.email?.trim().toLowerCase(),
      mobile_number: dto.mobile_number?.trim(),
      zoho_salesperson_id: zohoSalespersonId,
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
      role: admin.role || 'sales_admin',
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
      role: salesperson.role || 'salesperson',
      is_active: salesperson.is_active,
      created_by_admin_id: salesperson.created_by_admin_id,
      assigned_subadmin_id: salesperson.assigned_subadmin_id,
      last_login_at: salesperson.last_login_at,
    };
  }

  async loginSubAdmin(dto: SubAdminLoginDto) {
    const subadmin = await this.salesSubAdminModel.findOne({
      subadmin_id: dto.subadmin_id.trim(),
      is_active: true,
    });

    if (!subadmin) {
      throw new UnauthorizedException('Invalid subadmin credentials');
    }

    const passwordOk = await bcrypt.compare(dto.password, subadmin.password_hash);
    if (!passwordOk) {
      throw new UnauthorizedException('Invalid subadmin credentials');
    }

    subadmin.last_login_at = new Date();
    await subadmin.save();

    const access_token = this.signToken(
      subadmin._id.toString(),
      'subadmin',
      subadmin.subadmin_id,
    );

    return {
      access_token,
      subadmin: this.toSubAdminResponse(subadmin),
    };
  }

  async createSubAdmin(dto: CreateSubAdminDto, adminId: string) {
    const subadminId = dto.subadmin_id.trim();
    const existing = await this.salesSubAdminModel.exists({
      subadmin_id: subadminId,
    });

    if (existing) {
      throw new ConflictException('Sub Admin ID already exists');
    }

    const password_hash = await bcrypt.hash(dto.password, 10);
    const subadmin = await this.salesSubAdminModel.create({
      subadmin_id: subadminId,
      password_hash,
      name: dto.name.trim(),
      email: dto.email?.trim().toLowerCase(),
      mobile_number: dto.mobile_number?.trim(),
      created_by_admin_id: adminId,
    });

    return {
      message: 'Sub Admin created successfully',
      subadmin: this.toSubAdminResponse(subadmin),
    };
  }

  async updateSubAdmin(subadminId: string, updates: any) {
    const subadmin = await this.salesSubAdminModel.findOne({ subadmin_id: subadminId.trim() });
    if (!subadmin) {
      throw new NotFoundException('Sub Admin not found');
    }

    if (updates.name) subadmin.name = updates.name.trim();
    if (updates.email) subadmin.email = updates.email.trim().toLowerCase();
    if (updates.mobile_number !== undefined) subadmin.mobile_number = updates.mobile_number.trim();
    if (updates.password) subadmin.password_hash = await bcrypt.hash(updates.password, 10);
    if (updates.is_active !== undefined) subadmin.is_active = updates.is_active;

    await subadmin.save();
    return {
      message: 'Sub Admin updated successfully',
      subadmin: this.toSubAdminResponse(subadmin),
    };
  }

  async deleteSubAdmin(subadminId: string) {
    const deleted = await this.salesSubAdminModel.findOneAndDelete({
      subadmin_id: subadminId.trim(),
    });

    if (!deleted) {
      throw new NotFoundException('Sub Admin not found');
    }

    // Unassign salespeople from this subadmin
    await this.salespersonModel.updateMany(
      { assigned_subadmin_id: subadminId.trim() },
      { $unset: { assigned_subadmin_id: '' } },
    );

    return {
      message: 'Sub Admin deleted successfully',
      subadmin_id: subadminId,
    };
  }

  async assignSalesperson(salespersonId: string, subadminId: string | null) {
    const salesperson = await this.salespersonModel.findOne({ salesperson_id: salespersonId.trim() });
    if (!salesperson) {
      throw new NotFoundException('Salesperson not found');
    }

    if (subadminId) {
      const subadmin = await this.salesSubAdminModel.findOne({ subadmin_id: subadminId.trim() });
      if (!subadmin) {
        throw new NotFoundException('Sub Admin not found');
      }
      if (!subadmin.is_active) {
        throw new BadRequestException('Cannot assign salesperson to an inactive Sub Admin');
      }
      salesperson.assigned_subadmin_id = subadminId.trim();
    } else {
      salesperson.assigned_subadmin_id = undefined;
      await this.salespersonModel.updateOne(
        { salesperson_id: salespersonId.trim() },
        { $unset: { assigned_subadmin_id: '' } },
      );
    }

    await salesperson.save();
    return {
      message: subadminId ? 'Salesperson assigned successfully' : 'Salesperson unassigned successfully',
      salesperson: this.toSalespersonResponse(salesperson),
    };
  }

  private toSubAdminResponse(subadmin: SalesSubAdmin) {
    return {
      id: subadmin._id.toString(),
      subadmin_id: subadmin.subadmin_id,
      name: subadmin.name,
      email: subadmin.email,
      mobile_number: subadmin.mobile_number,
      role: subadmin.role || 'subadmin',
      is_active: subadmin.is_active,
      created_by_admin_id: subadmin.created_by_admin_id,
      last_login_at: subadmin.last_login_at,
    };
  }
}
