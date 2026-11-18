import { AlertTriangle, CheckCircle2, Clock, FileSearch, ShieldAlert, XCircle } from 'lucide-react';
import type { PaymentStatus, ProviderCode } from '../types/gateway.ts';

export function ProviderLabel({ provider }: { provider: ProviderCode | string }) {
  const styles: Record<string, { bar: string; text: string; name: string }> = {
    BKASH: { bar: 'bg-[#E2136E]', text: 'text-[#B90D58]', name: 'bKash' },
    NAGAD: { bar: 'bg-[#F6621F]', text: 'text-[#C8460C]', name: 'Nagad' },
    ROCKET: { bar: 'bg-[#8C3494]', text: 'text-[#712578]', name: 'Rocket' },
  };
  const cfg = styles[provider] ?? { bar: 'bg-slate-400', text: 'text-slate-700', name: provider };

  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-xs font-medium text-slate-900">
      <span className={`h-2.5 w-1 rounded-xs ${cfg.bar}`} aria-hidden="true" />
      <span className={cfg.text}>{cfg.name}</span>
    </span>
  );
}

export function PaymentStatusLabel({ status }: { status: PaymentStatus | string }) {
  switch (status) {
    case 'VERIFIED_SETTLED':
      return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span>Verified Settled</span>
        </span>
      );
    case 'CANDIDATE_MATCHED':
      return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-amber-700">
          <FileSearch className="h-3.5 w-3.5 shrink-0" />
          <span>Candidate Matched (Unverified)</span>
        </span>
      );
    case 'MANUAL_REVIEW_REQUIRED':
      return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-orange-700">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>Manual Review Required</span>
        </span>
      );
    case 'CUSTOMER_SUBMITTED':
      return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-sky-700">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          <span>Customer Submitted</span>
        </span>
      );
    case 'REJECTED':
      return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-rose-700">
          <XCircle className="h-3.5 w-3.5 shrink-0" />
          <span>Rejected</span>
        </span>
      );
    case 'EXPIRED':
      return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-slate-500">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          <span>Expired</span>
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-slate-600">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          <span>Awaiting Payment</span>
        </span>
      );
  }
}

export function ParseStatusLabel({ status }: { status: string }) {
  if (status === 'PARSED') {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        <span>Parsed</span>
      </span>
    );
  }
  if (status === 'DUPLICATE') {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-amber-700">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
        <span>Duplicate Blocked</span>
      </span>
    );
  }
  if (status === 'IGNORED_SECURITY') {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-rose-700">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
        <span>OTP/PIN Redacted</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-slate-600">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span>Unparsed</span>
    </span>
  );
}
