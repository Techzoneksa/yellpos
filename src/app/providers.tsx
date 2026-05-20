"use client";

import type { ReactNode } from "react";
import { NextAppProvider, NextCatalogProvider, NextSettingsProvider } from "@/lib/next-app-provider";
import { Phase3Provider } from "@/lib/phase3Store";
import { Phase5Provider } from "@/lib/phase5Store";
import { Phase6Provider } from "@/lib/phase6Store";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <NextAppProvider>
      <NextSettingsProvider>
        <NextCatalogProvider>
          <Phase3Provider>
            <Phase5Provider>
              <Phase6Provider>
                {children}
              </Phase6Provider>
            </Phase5Provider>
          </Phase3Provider>
        </NextCatalogProvider>
      </NextSettingsProvider>
    </NextAppProvider>
  );
}
