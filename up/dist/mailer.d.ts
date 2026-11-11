import type { AppConfig } from "./config";
export interface Mailer {
    send(opts: {
        to: string;
        subject: string;
        text: string;
        html: string;
    }): Promise<void>;
}
export declare function createMailer(cfg: AppConfig): Mailer;
