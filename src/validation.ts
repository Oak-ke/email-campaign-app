import { z } from "zod";

export const smtpSchema = z.object({
  host: z.string().min(1, "SMTP Host is required"),
  port: z.union([z.string(), z.number()]).transform((val) => Number(val) || 587),
  username: z.string().min(1, "SMTP Username / Email is required"),
  password: z.string().min(1, "SMTP Password is required"),
  use_ssl: z.boolean().optional().default(false),
  use_tls: z.boolean().optional().default(true),
  from_email: z.string().email("Invalid sender email format").optional(),
  from_name: z.string().optional()
});

export const recipientItemSchema = z.object({
  email: z.string().email("Invalid recipient email address"),
  name: z.string().optional(),
  company: z.string().optional()
});

export const recipientValidationSchema = z.object({
  recipients: z.array(z.any()).min(1, "Recipient list cannot be empty")
});

export const templateSchema = z.object({
  subject: z.string().min(1, "Subject cannot be empty"),
  body_html: z.string().min(1, "Email body cannot be empty"),
  attachments: z.array(
    z.object({
      name: z.string(),
      data: z.string().optional(),
      size: z.number().optional()
    })
  ).optional().default([])
});

export const campaignSettingsSchema = z.object({
  max_per_minute: z.union([z.string(), z.number()]).transform((val) => Number(val) || 30)
}).optional().default({ max_per_minute: 30 });

export const campaignStartSchema = z.object({
  smtp: smtpSchema.optional(),
  recipients: z.array(recipientItemSchema).min(1, "At least one valid recipient is required"),
  template: templateSchema,
  settings: campaignSettingsSchema
});

export const loginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required")
});

export const unsubscribeSchema = z.object({
  token: z.string().min(1, "Unsubscribe token is required"),
  email: z.string().email("Email is required").optional()
});
