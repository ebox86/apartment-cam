import "./../styles/globals.css";
import { siteConfig } from "../config/site-config";

export const metadata = {
  title: siteConfig.siteTitle,
  description: siteConfig.siteSubtitle,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="app-root">{children}</div>
      </body>
    </html>
  );
}
