// SPDX-License-Identifier: MIT
import * as nodemailer from "nodemailer";
import type { AppConfig } from "./config";

export interface Mailer {
  send(opts: { to: string; subject: string; text: string; html: string }): Promise<void>;
}

export function createMailer(cfg: AppConfig): Mailer {
  if (!cfg.smtp.host) {
    return {
      async send(opts) {
        const banner = "=".repeat(60);
        // eslint-disable-next-line no-console
        console.log(
          `\n${banner}\n[email] to=${opts.to} subject="${opts.subject}"\n${banner}\n${opts.text}\n`,
        );
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
  });
  return {
    async send(opts) {
      await transport.sendMail({
        from: cfg.smtp.from,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
      });
    },
  };
}
