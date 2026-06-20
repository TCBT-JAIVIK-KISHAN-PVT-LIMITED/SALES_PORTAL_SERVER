import { IsNotEmpty, IsString } from 'class-validator';

export class SubAdminLoginDto {
  @IsString()
  @IsNotEmpty()
  subadmin_id!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}
