export type EmailStatus =
  | "SCHEDULED"
  | "SENDING"
  | "SENT"
  | "FAILED"
  | "RATE_LIMITED";

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  slackConnected: boolean;
  slackTeamName: string | null;
  slackChannel: string | null;
}

export interface MeResponse {
  user: User;
}

export interface SenderSummary {
  name: string;
  email: string;
}

export interface Email {
  id: string;
  recipientEmail: string;
  subject: string;
  body: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  attempts: number;
  errorMessage: string | null;
  previewUrl: string | null;
  sender: SenderSummary;
}

export interface EmailListResponse {
  emails: Email[];
  total: number;
  page: number;
  pageSize: number;
}

export interface EmailStats {
  SCHEDULED: number;
  SENDING: number;
  SENT: number;
  FAILED: number;
  RATE_LIMITED: number;
}

export interface StatsResponse {
  stats: EmailStats;
}

export interface Campaign {
  id: string;
  subject: string;
  body: string;
  startTime: string;
  delayBetweenMs: number;
  hourlyLimit: number;
  totalRecipients: number;
  createdAt: string;
}

export interface CreateCampaignPayload {
  subject: string;
  body: string;
  startTime: string;
  delayBetweenMs: number;
  hourlyLimit: number;
  recipients: string[];
}

export interface CreateCampaignResponse {
  campaignId: string;
  totalRecipients: number;
  spacingMs: number;
  hourlyLimit: number;
  firstSendAt: string;
  lastSendAt: string;
}

export interface SearchHit {
  emailId: string;
  recipientEmail: string;
  senderEmail: string;
  subject: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  score: number | null;
}

export interface SearchResponse {
  searchAvailable: boolean;
  total: number;
  page: number;
  pageSize: number;
  hits: SearchHit[];
}
