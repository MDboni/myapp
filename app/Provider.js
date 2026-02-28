"use client";

import { Provider } from "react-redux";
import { store } from "./redux/state/store";

export default function Provide({ children }) {
  return <Provider store={store}>{children}</Provider>;
}