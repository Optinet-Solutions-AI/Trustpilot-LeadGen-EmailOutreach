import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Search, Users, Mail, BarChart3 } from 'lucide-react';

const NAV_ITEMS = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/scrape', icon: Search, label: 'Scrape' },
  { to: '/leads', icon: Users, label: 'Leads' },
  { to: '/campaigns', icon: Mail, label: 'Campaigns' },
  { to: '/analytics', icon: BarChart3, label: 'Analytics' },
];

export default function Sidebar() {
  return (
    <aside className="w-56 bg-gray-900 text-white flex flex-col min-h-screen">
      <div className="p-4 border-b border-gray-700">
        <h1 className="text-lg font-bold">Trustpilot CRM</h1>
        <p className="text-xs text-gray-400 mt-0.5">Lead Gen & Outreach</p>
      </div>
      <nav className="flex-1 py-4">
        {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                isActive ? 'bg-gray-800 text-white font-medium' : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
              }`
            }
          >
            <Icon size={18} />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
