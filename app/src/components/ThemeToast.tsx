import { useAppearance } from "@/lib/theme";

export function ThemeToast() {
  const toast = useAppearance().toast;
  if (!toast) return null;
  return (
    <div
      role="status"
      data-testid="theme-toast"
      className="panel-solid fixed bottom-32 left-1/2 z-[60] max-w-[86vw] -translate-x-1/2 rounded-xl px-4 py-2.5 text-sm md:bottom-28"
    >
      {toast.text}
    </div>
  );
}