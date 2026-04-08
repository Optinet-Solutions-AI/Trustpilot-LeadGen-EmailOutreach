import { useState } from 'react';
import { AlertTriangle, Send, X } from 'lucide-react';

interface Props {
  campaignName: string;
  recipientCount: number;
  rateLimit: { hourlyRemaining: number; dailyRemaining: number } | null;
  onConfirm: () => void;
  onClose: () => void;
}

export default function SendConfirmModal({ campaignName, recipientCount, rateLimit, onConfirm, onClose }: Props) {
  const [confirmText, setConfirmText] = useState('');
  const isConfirmed = confirmText.toUpperCase() === 'SEND';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="text-lg font-bold text-gray-900">Confirm Live Send</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          {/* Warning */}
          <div className="bg-red-50 border border-red-200 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle size={20} className="text-red-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-red-800">
                  This will send real emails to {recipientCount} lead{recipientCount !== 1 ? 's' : ''}
                </p>
                <p className="text-xs text-red-600 mt-1">
                  Emails will go to actual prospect inboxes. Personal emails (@gmail, @yahoo, etc.) are auto-filtered.
                  This action cannot be undone.
                </p>
              </div>
            </div>
          </div>

          {/* Campaign info */}
          <div className="bg-gray-50 rounded-xl p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Campaign</span>
              <span className="font-medium text-gray-800">{campaignName}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Recipients</span>
              <span className="font-medium text-gray-800">{recipientCount}</span>
            </div>
            {rateLimit && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Rate Limit</span>
                <span className="text-gray-600 text-xs">
                  {rateLimit.hourlyRemaining}/hr, {rateLimit.dailyRemaining}/day remaining
                </span>
              </div>
            )}
          </div>

          {/* Confirmation input */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Type <span className="font-bold text-red-600">SEND</span> to confirm:
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="Type SEND here"
              className="w-full border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500"
              autoFocus
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t bg-gray-50 rounded-b-2xl">
          <button onClick={onClose} className="text-sm text-gray-600 hover:text-gray-900">
            Cancel
          </button>
          <button
            onClick={() => { onConfirm(); onClose(); }}
            disabled={!isConfirmed}
            className="inline-flex items-center gap-2 bg-red-600 text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Send size={14} />
            Confirm & Send Live
          </button>
        </div>
      </div>
    </div>
  );
}
