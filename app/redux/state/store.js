// src/store/store.js
import { configureStore } from "@reduxjs/toolkit";
import countReducer from "../slice/countSlice";
import postReducer from "../slice/userSlice";
export const store = configureStore({
  reducer: {
    count: countReducer,
    post : postReducer,
  },
});