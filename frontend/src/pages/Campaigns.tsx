import { useEffect } from 'react';
import { useCampaigns } from '../hooks/useCampaigns';
import CampaignBuilder from '../components/CampaignBuilder';
import StatusBadge from '../components/StatusBadge';
import { Send, ImageIcon } from 'lucide-react';

export default function Campaigns() {
  const { campaigns, loading, fetchCampaigns, createCampaign, sendCampaign } = useCampaigns();

  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);

  const handleCreate = async (data: { name: string; templateSubject: string; templateBody: string; includeScreenshot: boolean; filterCountry?: string; filterCategory?: string }) => {
    await createCampaign(data);
  };

  const handleSend = async (id: string) => {
    if (!confirm('Send this campaign? This will email all pending leads.')) return;
    await sendCampaign(id);
    fetchCampaigns();
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Campaigns</h1>
      <CampaignBuilder onSubmit={handleCreate} />

      {/* Campaign List */}
      {campaigns.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="font-semibold mb-3">All Campaigns</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2">Name</th>
                <th className="text-left py-2">Status</th>
                <th className="text-right py-2">Sent</th>
                <th className="text-right py-2">Replied</th>
                <th className="text-right py-2">Bounced</th>
                <th className="text-right py-2">Date</th>
                <th className="w-20 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="border-b">
                  <td className="py-2 font-medium">
                    <span className="flex items-center gap-1.5">
                      {c.name}
                      {c.include_screenshot && (
                        <span title="Includes screenshot"><ImageIcon size={13} className="text-blue-400" /></span>
                      )}
                    </span>
                  </td>
                  <td className="py-2">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      c.status === 'sent' ? 'bg-green-100 text-green-700' :
                      c.status === 'completed' ? 'bg-purple-100 text-purple-700' :
                      'bg-gray-100 text-gray-700'
                    }`}>{c.status}</span>
                  </td>
                  <td className="text-right py-2">{c.total_sent}</td>
                  <td className="text-right py-2 text-green-600">{c.total_replied}</td>
                  <td className="text-right py-2 text-red-600">{c.total_bounced}</td>
                  <td className="text-right py-2 text-gray-500">
                    {new Date(c.created_at).toLocaleDateString()}
                  </td>
                  <td className="py-2 text-right">
                    {c.status === 'draft' && (
                      <button onClick={() => handleSend(c.id)}
                        className="inline-flex items-center gap-1 bg-green-600 text-white px-2 py-1 rounded text-xs hover:bg-green-700">
                        <Send size={10} /> Send
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
