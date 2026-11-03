import { TextProvider } from "@openbot/ui/text";
import { render } from "@solidjs/web";
import { ServerConsole } from "./ServerConsole";
import "./server-console.css";

const root = document.getElementById("root");
if (!root) throw new Error("The console root is missing.");

render(
  () => (
    <TextProvider locale="en">
      <ServerConsole />
    </TextProvider>
  ),
  root,
);
