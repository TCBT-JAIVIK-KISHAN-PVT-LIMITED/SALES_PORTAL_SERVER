import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Salesperson } from '../models/salesperson.schema';

@Injectable()
export class HierarchyGuard implements CanActivate {
  constructor(
    @InjectModel(Salesperson.name)
    private readonly salespersonModel: Model<Salesperson>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.salesUser;

    if (!user) {
      return false;
    }

    // Admin has full access, bypass hierarchy check
    if (user.role === 'sales_admin') {
      return true;
    }

    const salespersonId =
      request.params?.salespersonId ||
      request.body?.salespersonId ||
      request.query?.salespersonId;

    if (!salespersonId) {
      return true;
    }

    const trimmedSpId = salespersonId.trim();

    // Salesperson can only access their own data
    if (user.role === 'salesperson') {
      if (user.login_id !== trimmedSpId) {
        throw new ForbiddenException('Access denied: You can only access your own data');
      }
      return true;
    }

    // Sub Admin can only access their team members
    if (user.role === 'subadmin') {
      const salesperson = await this.salespersonModel.findOne({
        salesperson_id: trimmedSpId,
      });

      if (!salesperson) {
        throw new NotFoundException('Salesperson not found');
      }

      if (salesperson.assigned_subadmin_id !== user.login_id) {
        throw new ForbiddenException('Access denied: Salesperson does not belong to your team');
      }
      return true;
    }

    return false;
  }
}
