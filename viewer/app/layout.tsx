import "./../styles/globals.css";

export const metadata = {
  title: "Apartment Cam – Pittsburgh Skyline",
  description: "Live MJPEG feed from my apartment cam overlooking Pittsburgh.",
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
