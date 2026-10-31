import React, { useId } from 'react';
import Tooltip from '../../Tooltip/Tooltip';
import './ToggleSwitch.scss';

interface ToggleSwitchProps {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
  tooltip?: string;
  tooltipMaxWidth?: number;
  description?: string;
  className?: string;
}

const ToggleSwitch: React.FC<ToggleSwitchProps> = ({
  checked,
  onChange,
  label,
  disabled = false,
  tooltip,
  tooltipMaxWidth = 300,
  description,
  className = ''
}) => {
  const descriptionId = useId();
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      onChange();
    }
  };

  return (
    <div className={`toggle-switch-component ${description ? 'has-description' : ''} ${className}`}>
      <div
        className={`toggle-switch-label ${disabled ? 'disabled' : ''}`}
        onClick={disabled ? undefined : onChange}
        onKeyDown={disabled ? undefined : handleKeyDown}
        role="switch"
        aria-checked={checked}
        aria-disabled={disabled}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={disabled ? -1 : 0}
      >
        <div className="toggle-track-container">
          <input
            type="checkbox"
            checked={checked}
            readOnly
            disabled={disabled}
            tabIndex={-1}
          />
          <span className="toggle-track" />
        </div>
        <span className={`toggle-label-text ${checked ? 'active' : ''}`}>{label}</span>
      </div>
      {tooltip && (
        <Tooltip
          content={tooltip}
          position="top"
          icon="help"
          maxWidth={tooltipMaxWidth}
        />
      )}
      {description && <p className="toggle-switch-description" id={descriptionId}>{description}</p>}
    </div>
  );
};

export default ToggleSwitch;
