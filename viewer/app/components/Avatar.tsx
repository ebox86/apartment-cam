type AvatarProps = {
  disabled?: boolean;
  radius?: number | string;
  size?: number | string;
  label?: string;
};

export default function Avatar({
  disabled = true,
  radius = 9999,
  size = "clamp(44px, 8vw, 64px)",
  label = "Viewer avatar (disabled)",
}: AvatarProps) {
  const sizeValue = typeof size === "number" ? `${size}px` : size;
  const radiusValue = typeof radius === "number" ? `${radius}px` : radius;
  return (
    <button
      type="button"
      disabled={disabled}
      className="avatar-button"
      aria-label={label}
      title={label}
      style={{
        width: sizeValue,
        height: sizeValue,
        minWidth: sizeValue,
        minHeight: sizeValue,
        borderRadius: radiusValue,
      }}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
        className="avatar-icon"
      >
        <path
          d="M12 12.25a4.25 4.25 0 1 0 0-8.5 4.25 4.25 0 0 0 0 8.5Zm0 2.25c-3.4 0-6.4 1.72-7.5 4.36-.26.63.22 1.14.9 1.14h13.2c.68 0 1.16-.5.9-1.14-1.1-2.64-4.1-4.36-7.5-4.36Z"
          fill="currentColor"
        />
      </svg>
    </button>
  );
}
