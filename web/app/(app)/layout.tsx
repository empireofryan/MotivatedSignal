import DesignNav from "./DesignNav";
import s from "./DesignLayout.module.css";

export default function DesignLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className={s.frame}>
      <DesignNav />
      <div className={s.scroll}>{children}</div>
    </div>
  );
}
