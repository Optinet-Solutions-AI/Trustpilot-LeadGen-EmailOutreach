const STEPS = [
  { label: 'Setup',      icon: 'tune' },
  { label: 'Template',   icon: 'edit_note' },
  { label: 'Follow-ups', icon: 'schedule_send' },
  { label: 'Recipients', icon: 'group' },
  { label: 'Review',     icon: 'fact_check' },
];

interface Props {
  currentStep: number;
  completedSteps: Set<number>;
}

export default function WizardStepper({ currentStep, completedSteps }: Props) {
  return (
    <div className="flex items-center px-6 py-4 border-b border-slate-100">
      {STEPS.map((s, i) => {
        const isActive    = i === currentStep;
        const isCompleted = completedSteps.has(i);

        return (
          <div key={s.label} className="flex items-center flex-1 last:flex-none">
            {/* Step circle + label */}
            <div className="flex items-center gap-2 shrink-0">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
                isActive    ? 'primary-gradient text-on-primary shadow-sm' :
                isCompleted ? 'bg-[#006630] text-white' :
                              'bg-surface-container-high text-secondary'
              }`}>
                {isCompleted
                  ? <span className="material-symbols-outlined text-[14px]">check</span>
                  : <span className="text-xs font-extrabold">{i + 1}</span>
                }
              </div>
              <span className={`text-xs font-bold whitespace-nowrap ${
                isActive    ? 'text-[#b0004a]' :
                isCompleted ? 'text-[#006630]' :
                              'text-secondary'
              }`}>
                {s.label}
              </span>
            </div>

            {/* Connector line */}
            {i < STEPS.length - 1 && (
              <div className={`flex-1 h-px mx-3 ${isCompleted ? 'bg-[#006630]/40' : 'bg-slate-100'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
