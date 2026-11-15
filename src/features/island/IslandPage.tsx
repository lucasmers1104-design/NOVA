import { Page, PageHeader } from "@/components/layout/PageHeader";
import { IslandStudio } from "./studio/IslandStudio";

/** NOVA Island has its own tab: the studio needs the room of a whole page. */
export default function IslandPage() {
  return (
    <Page>
      <PageHeader title="NOVA Island" description="Die Insel oben am Bildschirm: Musik, Anrufe, Benachrichtigungen und NOVA. Was du hier änderst, siehst du sofort." />
      <div className="mx-auto max-w-[1180px]">
        <IslandStudio />
      </div>
    </Page>
  );
}
