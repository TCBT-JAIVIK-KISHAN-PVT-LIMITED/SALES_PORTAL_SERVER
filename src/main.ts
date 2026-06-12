import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as bodyParser from 'body-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false, // ✅ Disable default parser (IMPORTANT)
  });

  // ✅ Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // 🌍 CORS
  // 🌍 CORS MUST COME FIRST
  app.enableCors({
    origin: [
      'https://sales-portal-next.vercel.app',
      'http://localhost:3000',
    ],
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
    ],
  });

  app.use(
    helmet({
      crossOriginResourcePolicy: false,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('My API')
    .setDescription('Interactive API documentation')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, document);

  // 🔥 CRITICAL: RAW BODY for Zoho webhooks ONLY
  app.use('/payments/webhook', bodyParser.raw({ type: '*/*' }));
  app.use('/payments/webhook-sales-doc', bodyParser.raw({ type: '*/*' }));
  app.use('/sales-auth/salesperson/payments/webhook-sales-doc', bodyParser.raw({ type: '*/*' }));
  app.use('/sales-auth/salesperson/sales-orders/payments/webhook', bodyParser.raw({ type: '*/*' }));

  // ✅ Normal JSON parser for all other routes
  const bodyLimit = process.env.BODY_LIMIT || '10mb';
  app.use(bodyParser.json({ limit: bodyLimit }));
  app.use(bodyParser.urlencoded({ extended: true, limit: bodyLimit }));

  const port = Number(process.env.BACKEND_PORT ?? 3002);
  console.log(`[Nest] Starting on port ${port}`);
  await app.listen(port);
}

bootstrap();
