import { Check } from 'lucide-react';

const STEPS = ['Setup', 'Template', 'Recipients', 'Review'];

interface Props {
  currentStep: number;
  completedSteps: Set<number>;
}

export default function WizardStepper({ currentStep, completedSteps }: Props) {
  return (
    <div className="flex items-center justify-center gap-1 py-4 px-6">
      {STEPS.map((label, i) => {
        const isActive = i === currentStep;
        const isCompleted = completedSteps.has(i);
        return (
          <div key={label} className="flex items-center">
            {i > 0 && (
              <div className={`w-12 h-px mx-2 ${isCompleted || isActive ? 'bg-blue-400' : 'bg-gray-200'}`} />
            )}
            <div className="flex items-center gap-2">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${
                isActive ? 'bg-blue-600 text-white' :
                isCompleted ? 'bg-green-500 text-white' :
                'bg-gray-200 text-gray-500'
              }`}>
                {isCompleted ? <Check size={14} /> : i + 1}
              </div>
              <span className={`text-sm font-medium ${
                isActive ? 'text-blue-700' :
                isCompleted ? 'text-green-700' :
                'text-gray-400'
              }`}>{label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
