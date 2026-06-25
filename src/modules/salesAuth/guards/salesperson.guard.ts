import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class SalespersonGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers?.authorization;
    const token =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : null;

    if (!token) throw new UnauthorizedException('Missing salesperson token');

    try {
      const payload = this.jwtService.verify(token);

      if (
        payload?.auth_area !== 'sales_portal' ||
        !['salesperson', 'subadmin'].includes(payload?.role)
      ) {
        throw new UnauthorizedException('Sales portal access required');
      }

      request.salesUser = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid salesperson token');
    }
  }
}
