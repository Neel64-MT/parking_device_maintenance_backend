---

name: api-design-best-practices

description: Creates well-structured REST APIs in Node.js with Zod validation, advanced error handling, TypeScript types, and request logging. Use when building API endpoints or backend functionality in Node.js projects.

---

# API Design Best Practices for Node.js

## When to use this skill

Use this skill when creating REST API endpoints or backend functionality in Node.js projects. This ensures consistent, maintainable, and production-ready API endpoints.

## Setup Required Packages

Install necessary dependencies:

```bash

bun install express zod

```

## API Route Structure

All API routes go in the `src/routes/` directory following this pattern:

- `src/routes/users/route.ts` - For /api/users endpoint

- `src/routes/users/[id]/route.ts` - For /api/users/:id endpoint

## Standard Response Format

Always return responses in this consistent format:

```typescript

// Success response

{

  success: true,

  data: {...},

  message: "Optional success message"

}

// Error response

{

  success: false,

  error: "Error message",

  code: "ERROR_CODE"

}

```

## TypeScript Types

Create reusable types for API responses:

```typescript

// types/api.ts

export interface ApiResponse<T = any> {

  success: boolean;

  data?: T;

  message?: string;

  error?: string;

  code?: string;

  details?: any;

}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {

  pagination: {

    page: number;

    limit: number;

    total: number;

    totalPages: number;

  };

}

```

## Input Validation with Zod

Always validate incoming data using Zod schemas:

```typescript

import { z } from "zod";

// Define validation schema

const createUserSchema = z.object({

  name: z.string().min(2, "Name must be at least 2 characters").max(50),

  email: z.string().email("Invalid email format"),

  age: z.number().min(18, "Must be 18 or older").optional(),

  password: z

    .string()

    .min(8, "Password must be at least 8 characters")

    .regex(

      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,

      "Password must contain uppercase, lowercase, and number"

    ),

});

// Infer TypeScript type from schema

type CreateUserInput = z.infer<typeof createUserSchema>;

```

## Advanced Error Handling

Create a utility file for error handling:

```typescript

// lib/api-error.ts

import { z } from "zod";

import type { ApiResponse } from "@/types/api";

export class ApiError extends Error {

  constructor(

    public statusCode: number,

    public message: string,

    public code?: string

  ) {

    super(message);

    this.name = "ApiError";

  }

}

export function handleApiError(error: unknown): Response {

  // Zod validation errors

  if (error instanceof z.ZodError) {

    const response: ApiResponse = {

      success: false,

      error: "Validation failed",

      code: "VALIDATION_ERROR",

      details: error.errors.map((err) => ({

        field: err.path.join("."),

        message: err.message,

      })),

    };

    return Response.json(response, { status: 400 });

  }

  // Custom API errors

  if (error instanceof ApiError) {

    const response: ApiResponse = {

      success: false,

      error: error.message,

      code: error.code,

    };

    return Response.json(response, { status: error.statusCode });

  }

  // Database unique constraint errors

  if (error instanceof Error && error.message.includes("unique constraint")) {

    const response: ApiResponse = {

      success: false,

      error: "Resource already exists",

      code: "DUPLICATE_ERROR",

    };

    return Response.json(response, { status: 409 });

  }

  // Unknown errors

  console.error("Unexpected error:", error);

  const response: ApiResponse = {

    success: false,

    error: "Internal server error",

    code: "INTERNAL_ERROR",

  };

  return Response.json(response, { status: 500 });

}

```

## API Request Logger

Create a logger utility:

```typescript

// lib/api-logger.ts

import type { Request, Response, NextFunction } from "express";

interface LogData {

  method: string;

  url: string;

  status?: number;

  duration: number;

  ip?: string;

  userAgent?: string;

  error?: string;

}

export class ApiLogger {

  private startTime: number;

  constructor(private request: Request) {

    this.startTime = Date.now();

  }

  log(status: number, error?: string) {

    const duration = Date.now() - this.startTime;

    const url = new URL(this.request.url);

    const logData: LogData = {

      method: this.request.method,

      url: url.pathname + url.search,

      status,

      duration,

      ip: this.request.headers.get("x-forwarded-for") || "unknown",

      userAgent: this.request.headers.get("user-agent") || "unknown",

      error,

    };

    const logLevel = status >= 500 ? "ERROR" : status >= 400 ? "WARN" : "INFO";

    const timestamp = new Date().toISOString();

    console.log(`[${timestamp}] [${logLevel}] ${JSON.stringify(logData)}`);

  }

}

// Helper function to wrap route handlers with logging

export function withLogger<T>(

  handler: (request: Request, logger: ApiLogger) => Promise<Response>

) {

  return async (request: Request): Promise<Response> => {

    const logger = new ApiLogger(request);

    try {

      const response = await handler(request, logger);

      logger.log(response.status);

      return response;

    } catch (error) {

      logger.log(500, error instanceof Error ? error.message : "Unknown error");

      throw error;

    }

  };

}

```

## HTTP Methods Implementation

Implement proper HTTP methods:

- GET - Retrieve data

- POST - Create new resource

- PUT/PATCH - Update existing resource

- DELETE - Remove resource

## Status Codes

Use appropriate HTTP status codes:

- 200 - Success (GET, PUT, PATCH)

- 201 - Created (POST)

- 204 - No Content (DELETE)

- 400 - Bad Request (validation errors)

- 401 - Unauthorized

- 403 - Forbidden

- 404 - Not Found

- 409 - Conflict (duplicate)

- 500 - Internal Server Error

## Express Error Middleware

For unhandled errors that reach Express, use a final error-handling middleware:

// src/middleware/error-handler.ts

import type { Request, Response, NextFunction } from "express";
import { handleApiError } from "../lib/api-error";

export function errorHandler(
  error: unknown,
  request: Request,
  response: Response,
  next: NextFunction
) {
  const apiResponse = handleApiError(error);

  // handleApiError returns a Response-compatible result.
  // Adapt it to Express response handling in the implementation.
  return apiResponse;
}

Register the error middleware after all routes:

app.use(errorHandler);

## Complete Node.js API Route Example

// src/routes/users.ts

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";

import { handleApiError, ApiError } from "../lib/api-error";
import { ApiLogger, withLogger } from "../lib/api-logger";
import type { ApiResponse, PaginatedResponse } from "../types/api";

const router = Router();

// Validation schemas
const createUserSchema = z.object({
  name: z.string().min(2).max(50),
  email: z.string().email(),
  password: z
    .string()
    .min(8)
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
      "Password must contain uppercase, lowercase, and number"
    ),
  role: z.enum(["user", "admin"]).default("user"),
});

const querySchema = z.object({
  page: z.string().regex(/^\d+$/).transform(Number).default("1"),
  limit: z.string().regex(/^\d+$/).transform(Number).default("10"),
  search: z.string().optional(),
});

type User = {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: Date;
};

router.get(
  "/",
  withLogger(async (request: Request, logger: ApiLogger) => {
    try {
      // Validate query parameters
      const { page, limit, search } = querySchema.parse({
        page: request.query.page,
        limit: request.query.limit,
        search: request.query.search,
      });

      // Fetch users from database
      const users = await fetchUsers({ page, limit, search });
      const total = await countUsers({ search });

      const response: PaginatedResponse<User> = {
        success: true,
        data: users,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };

      return { body: response, status: 200 };
    } catch (error) {
      return handleApiError(error);
    }
  })
);

router.post(
  "/",
  withLogger(async (request: Request, logger: ApiLogger) => {
    try {
      // Validate request body with Zod
      const validatedData = createUserSchema.parse(request.body);

      // Check if user already exists
      const existingUser = await findUserByEmail(validatedData.email);

      if (existingUser) {
        throw new ApiError(
          409,
          "User with this email already exists",
          "USER_EXISTS"
        );
      }

      // Hash password
      const hashedPassword = await hashPassword(validatedData.password);

      // Create user
      const newUser = await createUser({
        ...validatedData,
        password: hashedPassword,
      });

      // Remove password from response
      const { password, ...userWithoutPassword } = newUser;

      const response: ApiResponse<User> = {
        success: true,
        data: userWithoutPassword,
        message: "User created successfully",
      };

      return { body: response, status: 201 };
    } catch (error) {
      return handleApiError(error);
    }
  })
);

export default router;

Register the router in the Node.js application:

// src/app.ts

import express from "express";
import usersRouter from "./routes/users";

const app = express();

app.use(express.json());

app.use("/api/users", usersRouter);

app.listen(5000, () => {
  console.log("API server running on port 5000");
});

## Dynamic Route with Validation

// src/routes/users.ts

import { Router, Request, Response } from "express";
import { z } from "zod";

import { handleApiError, ApiError } from "../lib/api-error";
import { withLogger } from "../lib/api-logger";
import type { ApiResponse } from "../types/api";

const router = Router();

const paramsSchema = z.object({
  id: z.string().uuid("Invalid user ID format"),
});

const updateUserSchema = z
  .object({
    name: z.string().min(2).max(50).optional(),
    email: z.string().email().optional(),
    role: z.enum(["user", "admin"]).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

router.get(
  "/:id",
  withLogger(async (request: Request, logger: ApiLogger) => {
    try {
      // Validate route parameters
      const { id } = paramsSchema.parse(request.params);

      const user = await findUserById(id);

      if (!user) {
        throw new ApiError(404, "User not found", "USER_NOT_FOUND");
      }

      const response: ApiResponse = {
        success: true,
        data: user,
      };

      return { body: response, status: 200 };
    } catch (error) {
      return handleApiError(error);
    }
  })
);

router.patch(
  "/:id",
  withLogger(async (request: Request, logger: ApiLogger) => {
    try {
      const { id } = paramsSchema.parse(request.params);

      // Validate update data
      const validatedData = updateUserSchema.parse(request.body);

      const updatedUser = await updateUser(id, validatedData);

      if (!updatedUser) {
        throw new ApiError(404, "User not found", "USER_NOT_FOUND");
      }

      const response: ApiResponse = {
        success: true,
        data: updatedUser,
        message: "User updated successfully",
      };

      return { body: response, status: 200 };
    } catch (error) {
      return handleApiError(error);
    }
  })
);

router.delete(
  "/:id",
  withLogger(async (request: Request, logger: ApiLogger) => {
    try {
      const { id } = paramsSchema.parse(request.params);

      const deleted = await deleteUser(id);

      if (!deleted) {
        throw new ApiError(404, "User not found", "USER_NOT_FOUND");
      }

      const response: ApiResponse = {
        success: true,
        message: "User deleted successfully",
      };

      return { body: response, status: 200 };
    } catch (error) {
      return handleApiError(error);
    }
  })
);

export default router;

## Common Zod Validation Patterns

```typescript

// Email validation

email: z.string().email();

// Strong password

password: z.string()

  .min(8)

  .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/);

// Phone number

phone: z.string().regex(/^\+?[1-9]\d{1,14}$/);

// URL

website: z.string().url();

// Enum

status: z.enum(["active", "inactive", "pending"]);

// Optional with default

role: z.string().default("user");

// Array with min/max

tags: z.array(z.string()).min(1).max(5);

// Nested object

address: z.object({

  street: z.string(),

  city: z.string(),

  zipCode: z.string().regex(/^\d{5}$/),

});

// Transform data

age: z.string().transform(Number);

// Date validation

birthDate: z.string().datetime();

// Number range

score: z.number().min(0).max(100);

```

## Best Practices Checklist

- [ ] Use Zod for all input validation

- [ ] Implement advanced error handling with custom error classes

- [ ] Use TypeScript types for all API responses

- [ ] Add API request logging

- [ ] Validate all incoming data (body, params, query)

- [ ] Use consistent response format

- [ ] Set correct HTTP status codes

- [ ] Remove sensitive data from responses

- [ ] Use environment variables for sensitive data

- [ ] Document your API endpoints

## Environment Variables

Store sensitive information in `.env.local`:

```

DATABASE_URL=your_database_url

API_SECRET_KEY=your_secret_key

JWT_SECRET=your_jwt_secret

```

Access them using `process.env.DATABASE_URL`

## Testing Your API

Test your endpoints using:

1. Thunder Client or Postman

2. Browser for GET requests

3. curl commands in terminal

Example curl test:

```bash

curl -X POST http://localhost:5000/api/users \

  -H "Content-Type: application/json" \

  -d '{"name":"John","email":"john@example.com","password":"Password123"}'

```

## Project-specific notes (Parking Device Maintenance)

- Use **Bun** as the runtime and package manager (`bun install`, `bun run`).
- Use **Express routers** in `src/routes/*.ts` (not Next.js `app/api` or `[id]/route.ts` folders).
- Use **PostgreSQL** via the `pg` driver with thin repository functions — do not add Prisma/Nest unless explicitly approved.
- Adapt `handleApiError` / `withLogger` for Express (`Request`/`Response`/`NextFunction`); return JSON via `res.status(...).json(...)`.
- Prefer `.env` / `.env.local` for secrets; never commit real credentials.

