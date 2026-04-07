interface Stat {
  label: string;
  value: number | string;
  color?: string;
}

export default function StatsRow({ stats }: { stats: Stat[] }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
      {stats.map((stat) => (
        <div key={stat.label} className="bg-white rounded-lg border border-gray-200 p-4">
          <p className="text-sm text-gray-500">{stat.label}</p>
          <p className={`text-2xl font-bold mt-1 ${stat.color || 'text-gray-900'}`}>
            {stat.value}
          </p>
        </div>
      ))}
    </div>
  );
}
