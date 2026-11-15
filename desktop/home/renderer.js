/* global document, location */
import { floating } from "./renderer-floating.js";
import { panel } from "./renderer-panel.js";

const query = new URLSearchParams(location.search);
const type = query.get("type");
const root = document.getElementById("root");
if (type === "panel") panel(root);
else floating(root, type, query.get("id"));
